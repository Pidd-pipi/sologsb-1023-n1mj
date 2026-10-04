import { computed, onMounted, ref, watch } from 'vue';
import { sampleVersions, splitIntoUnits } from '../data';
import type {
  AlignmentRow,
  CollationSnapshot,
  ComparisonRules,
  DifferenceStatus,
  PersistedCollationState,
  TextUnit,
  VersionDocument
} from '../types';

const STORAGE_KEY = 'sologsb-1023/multi-version-collation/v1';
const BACKUP_KEY = `${STORAGE_KEY}/backup`;
const MAX_SNAPSHOTS = 12;

const variantMap: Record<string, string> = {
  為: '为',
  爲: '为',
  識: '识',
  強: '强',
  與: '与',
  猶: '犹',
  鄰: '邻',
  儼: '俨',
  渙: '涣',
  將: '将',
  樸: '朴',
  曠: '旷',
  濁: '浊',
  靜: '静',
  動: '动',
  玅: '妙',
  裏: '里',
  裡: '里',
  說: '说',
  國: '国'
};

/** 状态均可 JSON 序列化（本地持久化的前提），用 JSON 往返同时剥离响应式代理 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function yieldToBrowser() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function normalized(value: string, rules: ComparisonRules) {
  let result = value.toLocaleLowerCase().trim();
  if (rules.ignoreVariants) {
    result = Array.from(result, (character) => variantMap[character] ?? character).join('');
  }
  if (rules.ignorePunctuation) {
    result = result.replace(/[\s，。！？；：、“”‘’「」『』（）()《》〈〉·,.!?;:'"[\]{}<>—\-…]/g, '');
  }
  return result;
}

function similarity(left: string, right: string) {
  const a = Array.from(left);
  const b = Array.from(right);
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const previous = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const old = previous[j];
      previous[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(previous[j], previous[j - 1]);
      diagonal = old;
    }
  }
  return previous[b.length] / Math.max(a.length, b.length);
}

function statusFor(left: TextUnit | undefined, right: TextUnit | undefined, ratio: number): DifferenceStatus {
  if (!left) return 'added';
  if (!right) return 'removed';
  if (ratio > 0.995) return 'same';
  if (ratio >= 0.38) return 'changed';
  return 'misaligned';
}

async function alignUnits(
  leftUnits: TextUnit[],
  rightUnits: TextUnit[],
  rules: ComparisonRules,
  allocateSeq: () => number,
  onProgress: (value: number) => void
): Promise<AlignmentRow[]> {
  const rows: AlignmentRow[] = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < leftUnits.length || rightIndex < rightUnits.length) {
    const left = leftUnits[leftIndex];
    const right = rightUnits[rightIndex];

    if (!left) {
      rows.push(makeRow(undefined, right, rules, '自动补齐右侧新增内容', allocateSeq()));
      rightIndex += 1;
    } else if (!right) {
      rows.push(makeRow(left, undefined, rules, '自动标记左侧缺失内容', allocateSeq()));
      leftIndex += 1;
    } else {
      const sameParagraph =
        left.paragraphOrder === right.paragraphOrder || Math.abs(left.paragraphOrder - right.paragraphOrder) <= 1;
      const ratio = similarity(normalized(left.text, rules), normalized(right.text, rules));
      const nextLeftRatio =
        leftUnits[leftIndex + 1] && right
          ? similarity(normalized(leftUnits[leftIndex + 1].text, rules), normalized(right.text, rules))
          : 0;
      const nextRightRatio =
        rightUnits[rightIndex + 1] && left
          ? similarity(normalized(left.text, rules), normalized(rightUnits[rightIndex + 1].text, rules))
          : 0;

      if (sameParagraph && (ratio >= 0.28 || (nextLeftRatio < 0.58 && nextRightRatio < 0.58))) {
        const score = Number(ratio.toFixed(3));
        rows.push({
          id: `row-${rows.length + 1}-${left.id}-${right.id}`,
          seq: allocateSeq(),
          left,
          right,
          status: statusFor(left, right, score),
          similarity: score,
          note: '',
          source: '',
          accepted: score > 0.995,
          manuallyAdjusted: false
        });
        leftIndex += 1;
        rightIndex += 1;
      } else if (nextRightRatio > ratio && nextRightRatio > nextLeftRatio) {
        rows.push(makeRow(undefined, right, rules, '右侧有段落或句子插入', allocateSeq()));
        rightIndex += 1;
      } else {
        rows.push(makeRow(left, undefined, rules, '左侧有段落或句子缺失', allocateSeq()));
        leftIndex += 1;
      }
    }

    if (rows.length % 24 === 0) {
      onProgress(Math.round(((leftIndex + rightIndex) / Math.max(1, leftUnits.length + rightUnits.length)) * 100));
      await yieldToBrowser();
    }
  }
  onProgress(100);
  return rows;
}

function makeRow(
  left: TextUnit | undefined,
  right: TextUnit | undefined,
  rules: ComparisonRules,
  source: string,
  seq: number
): AlignmentRow {
  const score = left && right ? Number(similarity(normalized(left.text, rules), normalized(right.text, rules)).toFixed(3)) : 0;
  return {
    id: `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    seq,
    left,
    right,
    status: statusFor(left, right, score),
    similarity: score,
    note: '',
    source,
    accepted: score > 0.995,
    manuallyAdjusted: false
  };
}

function defaultRules(): ComparisonRules {
  return { ignorePunctuation: true, ignoreVariants: true, candidateWindow: 3 };
}

/**
 * 兼容旧稿：缺句段编号的记录按顺序补齐编号并标记为待整理，
 * 返回推进后的发号器位置，保证编号跨快照、跨会话不重复。
 */
function ensureSeq(list: AlignmentRow[], start: number) {
  let max = 0;
  for (const row of list) {
    if (typeof row.seq === 'number' && Number.isFinite(row.seq)) max = Math.max(max, row.seq);
  }
  let cursor = Math.max(start, max + 1, 1);
  for (const row of list) {
    if (typeof row.seq !== 'number' || !Number.isFinite(row.seq)) {
      row.seq = cursor++;
      row.unfiled = true;
    }
  }
  return cursor;
}

export function useCollation() {
  const versions = ref<VersionDocument[]>(clone(sampleVersions));
  const leftVersionId = ref(versions.value[0].id);
  const rightVersionId = ref(versions.value[1].id);
  const rows = ref<AlignmentRow[]>([]);
  const rules = ref<ComparisonRules>(defaultRules());
  const snapshots = ref<CollationSnapshot[]>([]);
  const nextSeq = ref(1);
  const selectedRowId = ref('');
  const selectedRowIds = ref<(string | number)[]>([]);
  const processing = ref(false);
  const progress = ref(0);
  const message = ref('正在载入本地校勘数据…');
  const saveFailed = ref(false);
  const history = ref<string[]>([]);
  const future = ref<string[]>([]);
  const canUndo = computed(() => history.value.length > 0);
  const canRedo = computed(() => future.value.length > 0);
  const leftVersion = computed(() => versions.value.find((item) => item.id === leftVersionId.value));
  const rightVersion = computed(() => versions.value.find((item) => item.id === rightVersionId.value));
  const selectedRow = computed(() => rows.value.find((item) => item.id === selectedRowId.value));
  const differenceCount = computed(() => rows.value.filter((row) => row.status !== 'same').length);
  const acceptedCount = computed(() => rows.value.filter((row) => row.accepted).length);
  const unresolvedCount = computed(() => rows.value.filter((row) => !row.accepted && row.status !== 'same').length);
  const pendingReviewCount = computed(() => rows.value.filter((row) => row.needsReview).length);
  const unfiledCount = computed(() => rows.value.filter((row) => row.unfiled).length);

  /** 最近一次成功写入的草稿，保存失败时用于恢复 */
  let lastGood: string | null = null;

  function snapshot(): string {
    const data: PersistedCollationState = {
      schemaVersion: 2,
      versions: versions.value,
      leftVersionId: leftVersionId.value,
      rightVersionId: rightVersionId.value,
      rows: rows.value,
      rules: rules.value,
      selectedRowId: selectedRowId.value,
      snapshots: snapshots.value,
      nextSeq: nextSeq.value
    };
    return JSON.stringify(data);
  }

  function safeRead(key: string) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function persist() {
    const data = snapshot();
    try {
      localStorage.setItem(STORAGE_KEY, data);
      lastGood = data;
      saveFailed.value = false;
      try {
        localStorage.setItem(BACKUP_KEY, data);
      } catch {
        /* 备份写入失败不阻塞主流程 */
      }
    } catch {
      saveFailed.value = true;
      recoverDraft();
    }
  }

  /** 保存失败（多为本地空间不足）时回滚到上一份成功保存的草稿 */
  function recoverDraft() {
    const fallback = lastGood ?? safeRead(BACKUP_KEY);
    if (fallback) {
      try {
        applyState(JSON.parse(fallback) as PersistedCollationState);
        message.value = '保存失败：本地空间不足，已恢复之前的草稿';
        try {
          localStorage.setItem(STORAGE_KEY, fallback);
          saveFailed.value = false;
        } catch {
          /* 仍写不进则保留内存草稿，由用户导出备份 */
        }
        return;
      } catch {
        /* 备份草稿也已损坏，走下面的提示 */
      }
    }
    message.value = '保存失败且无法恢复草稿，请立即导出 JSON 备份当前工作';
  }

  function commit(label: string, mutate: () => void) {
    history.value.push(snapshot());
    if (history.value.length > 50) history.value.shift();
    future.value = [];
    mutate();
    message.value = label;
    persist();
  }

  function applyState(parsed: PersistedCollationState) {
    versions.value = parsed.versions ?? [];
    leftVersionId.value = parsed.leftVersionId ?? versions.value[0]?.id ?? '';
    rightVersionId.value = parsed.rightVersionId ?? versions.value[1]?.id ?? '';
    rules.value = { ...defaultRules(), ...(parsed.rules ?? {}) };
    snapshots.value = parsed.snapshots ?? [];
    const list = parsed.rows ?? [];
    nextSeq.value = ensureSeq(list, parsed.nextSeq ?? 1);
    rows.value = list;
    selectedRowId.value = parsed.selectedRowId ?? '';
    selectedRowIds.value = [];
  }

  function restore(raw: string) {
    applyState(JSON.parse(raw) as PersistedCollationState);
    persist();
  }

  function undo() {
    const previous = history.value.pop();
    if (!previous) return;
    future.value.push(snapshot());
    restore(previous);
    message.value = '已撤销上一步操作';
  }

  function redo() {
    const next = future.value.pop();
    if (!next) return;
    history.value.push(snapshot());
    restore(next);
    message.value = '已重做上一步操作';
  }

  async function runAlignment(commitHistory = true) {
    if (!leftVersion.value || !rightVersion.value || processing.value) return;
    processing.value = true;
    progress.value = 0;
    message.value = '正在分片执行自动对齐…';
    const previous = commitHistory ? snapshot() : '';
    try {
      const result = await alignUnits(
        leftVersion.value.units,
        rightVersion.value.units,
        rules.value,
        () => nextSeq.value++,
        (value) => {
          progress.value = value;
        }
      );
      if (commitHistory) {
        history.value.push(previous);
        future.value = [];
      }
      rows.value = result;
      selectedRowId.value = result.find((row) => row.status !== 'same')?.id ?? result[0]?.id ?? '';
      selectedRowIds.value = [];
      message.value = `自动对齐完成：${result.filter((row) => row.status !== 'same').length} 处差异`;
      persist();
    } finally {
      processing.value = false;
    }
  }

  /**
   * 比较规则调整后定向重算：只有判断真正发生变化的记录回到待复核，
   * 校勘说明和来源原样保留；未受影响的记录（含已接受的）不动。
   */
  function recalculate() {
    let affected = 0;
    commit('已按比较规则重算差异', () => {
      rows.value = rows.value.map((row) => {
        if (!row.left || !row.right) return row;
        const score = Number(
          similarity(normalized(row.left.text, rules.value), normalized(row.right.text, rules.value)).toFixed(3)
        );
        const nextStatus = statusFor(row.left, row.right, score);
        if (nextStatus === row.status && Math.abs(score - row.similarity) < 0.0005) return row;
        affected += 1;
        return {
          ...row,
          similarity: score,
          status: nextStatus,
          accepted: false,
          needsReview: true,
          reviewReason: '比较规则调整后判断有变化，待复核'
        };
      });
      selectedRowIds.value = [];
    });
    if (affected) {
      message.value = `规则已调整：${affected} 条记录判断有变化，待复核；校记与来源已保留`;
    } else {
      message.value = '规则已调整：没有记录的判断发生变化，已接受的校记不受影响';
    }
  }

  function updateRow(id: string, patch: Partial<AlignmentRow>) {
    commit('已更新校勘行', () => {
      const row = rows.value.find((item) => item.id === id);
      if (!row) return;
      Object.assign(row, patch, { manuallyAdjusted: true });
      if (patch.status !== undefined || patch.accepted !== undefined) {
        row.needsReview = false;
        row.reviewReason = undefined;
      }
    });
  }

  function shiftPairing(id: string, direction: -1 | 1) {
    commit(direction < 0 ? '已向前调整错位' : '已向后调整错位', () => {
      const index = rows.value.findIndex((row) => row.id === id);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= rows.value.length) return;
      const current = rows.value[index];
      const target = rows.value[targetIndex];
      const currentLeft = current.left;
      current.left = target.left;
      target.left = currentLeft;
      for (const row of [current, target]) {
        if (row.left && row.right) {
          row.similarity = Number(
            similarity(normalized(row.left.text, rules.value), normalized(row.right.text, rules.value)).toFixed(3)
          );
          row.status = statusFor(row.left, row.right, row.similarity);
        } else {
          row.status = row.left ? 'removed' : 'added';
          row.similarity = 0;
        }
        row.manuallyAdjusted = true;
      }
    });
  }

  function moveRow(id: string, direction: -1 | 1) {
    commit('已移动校勘顺序', () => {
      const index = rows.value.findIndex((row) => row.id === id);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= rows.value.length) return;
      const [row] = rows.value.splice(index, 1);
      rows.value.splice(targetIndex, 0, row);
      row.manuallyAdjusted = true;
    });
  }

  function acceptRows(ids: string[]) {
    if (!ids.length) return;
    commit(`已接受 ${ids.length} 条校对建议`, () => {
      const selected = new Set(ids);
      rows.value.forEach((row) => {
        if (selected.has(row.id)) {
          row.accepted = true;
          row.needsReview = false;
          row.reviewReason = undefined;
        }
      });
      selectedRowIds.value = [];
    });
  }

  function acceptAll() {
    commit('已批量接受全部差异建议', () => {
      rows.value.forEach((row) => {
        row.accepted = true;
        row.needsReview = false;
        row.reviewReason = undefined;
      });
      selectedRowIds.value = [];
    });
  }

  /** 待复核记录确认后一次写入 */
  function confirmPendingReview() {
    const count = pendingReviewCount.value;
    if (!count) return;
    commit(`已一次确认 ${count} 条待复核记录`, () => {
      rows.value.forEach((row) => {
        if (row.needsReview) {
          row.needsReview = false;
          row.reviewReason = undefined;
          row.accepted = true;
        }
      });
      selectedRowIds.value = [];
    });
  }

  /** 旧稿补齐编号的记录确认整理后一次写入 */
  function settleUnfiledRows() {
    const count = unfiledCount.value;
    if (!count) return;
    commit(`已确认 ${count} 条补齐编号的旧稿记录`, () => {
      rows.value.forEach((row) => {
        if (row.unfiled) row.unfiled = false;
      });
    });
  }

  function nextDifference() {
    const start = rows.value.findIndex((row) => row.id === selectedRowId.value);
    for (let offset = 1; offset <= rows.value.length; offset += 1) {
      const index = (start + offset) % rows.value.length;
      const row = rows.value[index];
      if (row && row.status !== 'same' && !row.accepted) {
        selectedRowId.value = row.id;
        message.value = `已跳到第 ${index + 1} 条未接受差异`;
        persist();
        return;
      }
    }
    message.value = '没有更多未接受的差异';
  }

  function addVersion(name: string, source: string, text: string) {
    const id = `version-${Date.now().toString(36)}`;
    const item: VersionDocument = {
      id,
      name: name.trim() || `版本 ${versions.value.length + 1}`,
      source: source.trim() || '手工导入',
      text,
      units: splitIntoUnits(text, id),
      createdAt: new Date().toISOString()
    };
    commit(`已导入版本：${item.name}`, () => {
      versions.value.push(item);
    });
    rightVersionId.value = id;
    void runAlignment();
  }

  /** 保存版本快照：校勘记录与当时的比较规则一起固化 */
  function saveSnapshot(name?: string) {
    const label = name?.trim() || `快照 ${snapshots.value.length + 1}`;
    const item: CollationSnapshot = {
      id: `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: label,
      createdAt: new Date().toISOString(),
      leftVersionId: leftVersionId.value,
      rightVersionId: rightVersionId.value,
      rules: clone(rules.value),
      rows: clone(rows.value),
      differenceCount: rows.value.filter((row) => row.status !== 'same').length
    };
    commit(`已保存版本快照：${label}`, () => {
      snapshots.value.push(item);
      if (snapshots.value.length > MAX_SNAPSHOTS) snapshots.value.shift();
    });
  }

  /** 载入快照：句段编号沿用快照内的编号，发号器推进到最大编号之后 */
  function loadSnapshot(id: string) {
    const item = snapshots.value.find((entry) => entry.id === id);
    if (!item) return;
    commit(`已载入版本快照：${item.name}`, () => {
      rows.value = clone(item.rows);
      rules.value = { ...defaultRules(), ...clone(item.rules) };
      leftVersionId.value = item.leftVersionId;
      rightVersionId.value = item.rightVersionId;
      nextSeq.value = ensureSeq(rows.value, nextSeq.value);
      selectedRowId.value = rows.value.find((row) => row.status !== 'same')?.id ?? rows.value[0]?.id ?? '';
      selectedRowIds.value = [];
    });
  }

  function removeSnapshot(id: string) {
    const item = snapshots.value.find((entry) => entry.id === id);
    if (!item) return;
    commit(`已删除版本快照：${item.name}`, () => {
      snapshots.value = snapshots.value.filter((entry) => entry.id !== id);
    });
  }

  function exportMarkdown() {
    const changed = rows.value.filter((row) => row.status !== 'same' || row.note || row.source);
    const lines = [
      '# 校勘记',
      '',
      `- 底本：${leftVersion.value?.name ?? '未选择'}`,
      `- 参校本：${rightVersion.value?.name ?? '未选择'}`,
      `- 比较规则：${rules.value.ignorePunctuation ? '忽略标点；' : ''}${rules.value.ignoreVariants ? '忽略异体字；' : ''}保留正文。`,
      `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
      '',
      '| 句段 | 类别 | 底本 | 参校本 | 校记 | 来源 | 状态 |',
      '|---|---|---|---|---|---|---|'
    ];
    changed.forEach((row) => {
      const cell = (value?: string) => (value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
      const state = row.accepted ? '已接受' : row.needsReview ? '待复核' : '待处理';
      lines.push(
        `| ${row.seq} | ${statusLabel(row.status)} | ${cell(row.left?.text)} | ${cell(row.right?.text)} | ${cell(row.note)} | ${cell(row.source)} | ${state} |`
      );
    });
    lines.push('', `共 ${changed.length} 条校勘记录。`);
    return lines.join('\n');
  }

  function exportJson() {
    return JSON.stringify(
      {
        schemaVersion: 2,
        left: leftVersion.value,
        right: rightVersion.value,
        rules: rules.value,
        rows: rows.value,
        snapshots: snapshots.value,
        nextSeq: nextSeq.value,
        exportedAt: new Date().toISOString()
      },
      null,
      2
    );
  }

  onMounted(() => {
    const raw = safeRead(STORAGE_KEY);
    const backup = safeRead(BACKUP_KEY);
    for (const candidate of [raw, backup]) {
      if (!candidate) continue;
      try {
        applyState(JSON.parse(candidate) as PersistedCollationState);
        lastGood = candidate;
        message.value = candidate === raw ? '已恢复浏览器中的校勘草稿' : '主草稿不可用，已从备份恢复校勘草稿';
        if (candidate !== raw) persist();
        return;
      } catch {
        /* 当前候选损坏，尝试下一份 */
      }
    }
    message.value = '已载入示例版本，正在自动对齐…';
    void runAlignment(false);
  });

  watch(
    [leftVersionId, rightVersionId, () => rules.value.ignorePunctuation, () => rules.value.ignoreVariants],
    () => {
      if (!processing.value) persist();
    }
  );

  return {
    versions,
    leftVersionId,
    rightVersionId,
    rows,
    rules,
    snapshots,
    selectedRowId,
    selectedRowIds,
    processing,
    progress,
    message,
    saveFailed,
    history,
    future,
    canUndo,
    canRedo,
    leftVersion,
    rightVersion,
    selectedRow,
    differenceCount,
    acceptedCount,
    unresolvedCount,
    pendingReviewCount,
    unfiledCount,
    runAlignment,
    recalculate,
    updateRow,
    shiftPairing,
    moveRow,
    acceptRows,
    acceptAll,
    confirmPendingReview,
    settleUnfiledRows,
    nextDifference,
    addVersion,
    saveSnapshot,
    loadSnapshot,
    removeSnapshot,
    undo,
    redo,
    exportMarkdown,
    exportJson,
    commit
  };
}

export function statusLabel(status: DifferenceStatus) {
  return {
    same: '相同',
    changed: '改动',
    added: '右侧新增',
    removed: '左侧删减',
    misaligned: '疑错位'
  }[status];
}
