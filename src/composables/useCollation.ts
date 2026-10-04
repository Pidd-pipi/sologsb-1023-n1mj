import { computed, onMounted, ref, watch } from 'vue';
import { sampleVersions, splitIntoUnits } from '../data';
import type {
  AlignmentRow,
  CollationSnapshot,
  ComparisonRules,
  DifferenceStatus,
  TextUnit,
  VersionDocument
} from '../types';

const STORAGE_KEY = 'sologsb-1023/multi-version-collation/v1';
/** 快照格式版本：v2 起校勘记录、比较规则与句段编号一并存入快照 */
const SNAPSHOT_VERSION = 2;

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

function clone<T>(value: T): T {
  return structuredClone(value);
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
  onProgress: (value: number) => void
): Promise<AlignmentRow[]> {
  const rows: AlignmentRow[] = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < leftUnits.length || rightIndex < rightUnits.length) {
    const left = leftUnits[leftIndex];
    const right = rightUnits[rightIndex];

    if (!left) {
      rows.push(makeRow(undefined, right, rules, '自动补齐右侧新增内容'));
      rightIndex += 1;
    } else if (!right) {
      rows.push(makeRow(left, undefined, rules, '自动标记左侧缺失内容'));
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
          left,
          right,
          status: statusFor(left, right, score),
          similarity: score,
          note: '',
          source: '',
          accepted: score > 0.995,
          manuallyAdjusted: false,
          needsReview: false
        });
        leftIndex += 1;
        rightIndex += 1;
      } else if (nextRightRatio > ratio && nextRightRatio > nextLeftRatio) {
        rows.push(makeRow(undefined, right, rules, '右侧有段落或句子插入'));
        rightIndex += 1;
      } else {
        rows.push(makeRow(left, undefined, rules, '左侧有段落或句子缺失'));
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
  source: string
): AlignmentRow {
  const score = left && right ? Number(similarity(normalized(left.text, rules), normalized(right.text, rules)).toFixed(3)) : 0;
  return {
    id: `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    left,
    right,
    status: statusFor(left, right, score),
    similarity: score,
    note: '',
    source,
    accepted: score > 0.995,
    manuallyAdjusted: false,
    needsReview: false
  };
}

function defaultRules(): ComparisonRules {
  return { ignorePunctuation: true, ignoreVariants: true, candidateWindow: 3 };
}

export function useCollation() {
  const versions = ref<VersionDocument[]>(clone(sampleVersions));
  const leftVersionId = ref(versions.value[0].id);
  const rightVersionId = ref(versions.value[1].id);
  const rows = ref<AlignmentRow[]>([]);
  const rules = ref<ComparisonRules>(defaultRules());
  const selectedRowId = ref('');
  const selectedRowIds = ref<(string | number)[]>([]);
  const processing = ref(false);
  const progress = ref(0);
  const message = ref('正在载入本地校勘数据…');
  const history = ref<CollationSnapshot[]>([]);
  const future = ref<CollationSnapshot[]>([]);
  /** 待整理区：旧稿缺编号、恢复快照时被兼容补齐的句段 id */
  const pendingOrganize = ref<string[]>([]);
  /** 工作台只看待复核记录 */
  const reviewOnly = ref(false);
  const canUndo = computed(() => history.value.length > 0);
  const canRedo = computed(() => future.value.length > 0);
  const leftVersion = computed(() => versions.value.find((item) => item.id === leftVersionId.value));
  const rightVersion = computed(() => versions.value.find((item) => item.id === rightVersionId.value));
  const selectedRow = computed(() => rows.value.find((item) => item.id === selectedRowId.value));
  const differenceCount = computed(() => rows.value.filter((row) => row.status !== 'same').length);
  const acceptedCount = computed(() => rows.value.filter((row) => row.accepted).length);
  const unresolvedCount = computed(() => rows.value.filter((row) => !row.accepted && row.status !== 'same').length);
  /** 待复核：规则变化后自动判断与当前判断不一致的记录 */
  const reviewCount = computed(() => rows.value.filter((row) => row.needsReview).length);
  const pendingOrganizeCount = computed(() => pendingOrganize.value.length);

  /** 最近一次成功写入的快照原文，保存失败时用于恢复草稿 */
  let lastGoodRaw = '';

  function snapshot(): CollationSnapshot {
    return {
      version: SNAPSHOT_VERSION,
      savedAt: new Date().toISOString(),
      versions: versions.value,
      leftVersionId: leftVersionId.value,
      rightVersionId: rightVersionId.value,
      rows: rows.value,
      rules: rules.value,
      selectedRowId: selectedRowId.value,
      pendingOrganize: pendingOrganize.value
    };
  }

  function persist() {
    const raw = JSON.stringify(snapshot());
    try {
      localStorage.setItem(STORAGE_KEY, raw);
      lastGoodRaw = raw;
    } catch {
      // 保存失败：恢复到上一版草稿，避免内存态与浏览器存储不一致
      let restored = false;
      if (lastGoodRaw) {
        try {
          applyState(JSON.parse(lastGoodRaw) as CollationSnapshot);
          restored = true;
        } catch {
          /* 忽略恢复过程中的二次异常 */
        }
      }
      message.value = restored ? '本地保存失败，已恢复到上一版草稿' : '本地保存失败，请重试';
    }
  }

  function commit(label: string, mutate: () => void) {
    history.value.push(snapshot());
    if (history.value.length > 50) history.value.shift();
    future.value = [];
    mutate();
    message.value = label;
    persist();
  }

  /**
   * 跨快照沿用句段编号：仅补齐缺失的 paragraphOrder / sentenceOrder，
   * 已有的编号原样保留。被补齐的句段进入待整理区。
   */
  function ensureNumbering(versions: VersionDocument[]): string[] {
    const pending: string[] = [];
    for (const version of versions) {
      const usedSentenceOrders = new Set<number>();
      let maxSentenceOrder = 0;
      version.units.forEach((unit) => {
        if (Number.isFinite(unit.sentenceOrder) && unit.sentenceOrder > 0) {
          usedSentenceOrders.add(unit.sentenceOrder);
          maxSentenceOrder = Math.max(maxSentenceOrder, unit.sentenceOrder);
        }
      });
      let nextSentenceOrder = maxSentenceOrder + 1;
      let paragraphOrder = 0;
      let lastParagraphText = '';
      version.units.forEach((unit) => {
        const missing =
          !Number.isFinite(unit.paragraphOrder) || unit.paragraphOrder <= 0 ||
          !Number.isFinite(unit.sentenceOrder) || unit.sentenceOrder <= 0;
        if (missing) {
          const match = /-p-(\d+)/.exec(unit.paragraphId ?? '');
          if (match) {
            paragraphOrder = Number(match[1]);
          } else if (unit.paragraphText && unit.paragraphText !== lastParagraphText) {
            paragraphOrder += 1;
          }
          unit.paragraphOrder = paragraphOrder || 1;
          while (usedSentenceOrders.has(nextSentenceOrder)) nextSentenceOrder += 1;
          unit.sentenceOrder = nextSentenceOrder;
          usedSentenceOrders.add(nextSentenceOrder);
          nextSentenceOrder += 1;
          unit.numberingMissing = true;
          pending.push(unit.id);
        } else {
          paragraphOrder = unit.paragraphOrder;
        }
        lastParagraphText = unit.paragraphText ?? '';
      });
    }
    return pending;
  }

  function applyState(parsed: CollationSnapshot) {
    versions.value = parsed.versions;
    leftVersionId.value = parsed.leftVersionId;
    rightVersionId.value = parsed.rightVersionId;
    rows.value = parsed.rows;
    rules.value = parsed.rules;
    selectedRowId.value = parsed.selectedRowId;
    pendingOrganize.value = ensureNumbering(parsed.versions);
  }

  function restore(raw: string) {
    const parsed = JSON.parse(raw) as CollationSnapshot;
    applyState(parsed);
    persist();
  }

  function restoreSnapshot(snap: CollationSnapshot) {
    applyState(snap);
    persist();
  }

  function undo() {
    const previous = history.value.pop();
    if (!previous) return;
    future.value.push(snapshot());
    restoreSnapshot(previous);
    message.value = '已撤销上一步操作';
  }

  function redo() {
    const next = future.value.pop();
    if (!next) return;
    history.value.push(snapshot());
    restoreSnapshot(next);
    message.value = '已重做上一步操作';
  }

  async function runAlignment(commitHistory = true) {
    if (!leftVersion.value || !rightVersion.value || processing.value) return;
    processing.value = true;
    progress.value = 0;
    message.value = '正在分片执行自动对齐…';
    const previous = commitHistory ? snapshot() : null;
    try {
      const result = await alignUnits(leftVersion.value.units, rightVersion.value.units, rules.value, (value) => {
        progress.value = value;
      });
      if (commitHistory && previous) {
        history.value.push(previous);
        future.value = [];
      }
      rows.value = result.map((row) => ({ ...row, needsReview: false, suggestedStatus: undefined }));
      selectedRowId.value = result.find((row) => row.status !== 'same')?.id ?? result[0]?.id ?? '';
      selectedRowIds.value = [];
      message.value = `自动对齐完成：${result.filter((row) => row.status !== 'same').length} 处差异`;
      persist();
    } finally {
      processing.value = false;
    }
  }

  /**
   * 规则变化重算：只让自动判断发生变化的记录进入待复核，
   * 原校记、来源与已接受状态全部保留；未受影响的记录不动。
   */
  function recalculate() {
    commit('规则变化：受影响记录待复核', () => {
      rows.value = rows.value.map((row) => {
        if (!row.left || !row.right) {
          return { ...row, needsReview: false, suggestedStatus: undefined };
        }
        const score = Number(
          similarity(normalized(row.left.text, rules.value), normalized(row.right.text, rules.value)).toFixed(3)
        );
        const autoStatus = statusFor(row.left, row.right, score);
        if (autoStatus !== row.status) {
          return { ...row, similarity: score, needsReview: true, suggestedStatus: autoStatus };
        }
        return { ...row, similarity: score, needsReview: false, suggestedStatus: undefined };
      });
      selectedRowIds.value = [];
    });
  }

  function updateRow(id: string, patch: Partial<AlignmentRow>) {
    commit('已更新校勘行', () => {
      const row = rows.value.find((item) => item.id === id);
      if (row) {
        Object.assign(row, patch, { manuallyAdjusted: true });
        // 人工改判即视为已复核，清除待复核标记
        if (patch.status) {
          row.needsReview = false;
          row.suggestedStatus = undefined;
        }
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
        row.needsReview = false;
        row.suggestedStatus = undefined;
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
        if (selected.has(row.id)) row.accepted = true;
      });
      selectedRowIds.value = [];
    });
  }

  function acceptAll() {
    commit('已批量接受全部差异建议', () => {
      rows.value.forEach((row) => {
        row.accepted = true;
      });
      selectedRowIds.value = [];
    });
  }

  /** 采纳某条待复核记录的规则建议，一次写入并标记已接受 */
  function applySuggestion(id: string) {
    const row = rows.value.find((item) => item.id === id);
    if (!row || !row.needsReview || !row.suggestedStatus) return;
    commit('已采纳复核建议', () => {
      row.status = row.suggestedStatus!;
      row.needsReview = false;
      row.suggestedStatus = undefined;
      row.accepted = true;
      row.manuallyAdjusted = true;
    });
  }

  /** 保持某条待复核记录的原判，仅清除待复核标记 */
  function keepStatus(id: string) {
    const row = rows.value.find((item) => item.id === id);
    if (!row || !row.needsReview) return;
    commit('已保持原判', () => {
      row.needsReview = false;
      row.suggestedStatus = undefined;
    });
  }

  /** 一次确认全部待复核记录：采纳规则建议并写入存储 */
  function confirmAllReviews() {
    const pending = rows.value.filter((row) => row.needsReview);
    if (!pending.length) return;
    commit(`已一次确认 ${pending.length} 条待复核记录`, () => {
      pending.forEach((row) => {
        if (row.suggestedStatus) row.status = row.suggestedStatus;
        row.needsReview = false;
        row.suggestedStatus = undefined;
        row.accepted = true;
      });
      selectedRowIds.value = [];
    });
  }

  /** 待整理区：标记某个缺编号句段已整理 */
  function dismissOrganize(unitId: string) {
    commit('已整理句段编号', () => {
      pendingOrganize.value = pendingOrganize.value.filter((id) => id !== unitId);
      for (const version of versions.value) {
        const unit = version.units.find((item) => item.id === unitId);
        if (unit) unit.numberingMissing = false;
      }
    });
  }

  /** 待整理区：一次标记全部缺编号句段已整理 */
  function dismissAllOrganize() {
    if (!pendingOrganize.value.length) return;
    commit('已完成全部句段编号整理', () => {
      for (const version of versions.value) {
        version.units.forEach((unit) => {
          unit.numberingMissing = false;
        });
      }
      pendingOrganize.value = [];
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
      '| 序 | 类别 | 底本 | 参校本 | 校记 | 来源 | 状态 |',
      '|---|---|---|---|---|---|---|'
    ];
    changed.forEach((row, index) => {
      const cell = (value?: string) => (value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
      lines.push(
        `| ${index + 1} | ${statusLabel(row.status)} | ${cell(row.left?.text)} | ${cell(row.right?.text)} | ${cell(row.note)} | ${cell(row.source)} | ${row.accepted ? '已接受' : '待处理'} |`
      );
    });
    lines.push('', `共 ${changed.length} 条校勘记录。`);
    return lines.join('\n');
  }

  function exportJson() {
    return JSON.stringify(
      {
        version: SNAPSHOT_VERSION,
        savedAt: new Date().toISOString(),
        left: leftVersion.value,
        right: rightVersion.value,
        rules: rules.value,
        rows: rows.value,
        pendingOrganize: pendingOrganize.value,
        exportedAt: new Date().toISOString()
      },
      null,
      2
    );
  }

  onMounted(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        restore(raw);
        message.value = '已恢复浏览器中的校勘草稿';
      } else {
        message.value = '已载入示例版本，正在自动对齐…';
        void runAlignment(false);
      }
    } catch {
      message.value = '本地草稿读取失败，已载入示例数据';
      void runAlignment(false);
    }
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
    selectedRowId,
    selectedRowIds,
    processing,
    progress,
    message,
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
    reviewCount,
    pendingOrganize,
    pendingOrganizeCount,
    reviewOnly,
    runAlignment,
    recalculate,
    updateRow,
    shiftPairing,
    moveRow,
    acceptRows,
    acceptAll,
    applySuggestion,
    keepStatus,
    confirmAllReviews,
    dismissOrganize,
    dismissAllOrganize,
    nextDifference,
    addVersion,
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
