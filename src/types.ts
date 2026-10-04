export type DifferenceStatus = 'same' | 'changed' | 'added' | 'removed' | 'misaligned';

export interface TextUnit {
  id: string;
  paragraphId: string;
  paragraphOrder: number;
  sentenceOrder: number;
  paragraphText: string;
  text: string;
  /** 旧稿缺编号、恢复快照时被兼容补齐的句段，进入待整理区 */
  numberingMissing?: boolean;
}

export interface VersionDocument {
  id: string;
  name: string;
  source: string;
  createdAt: string;
  text: string;
  units: TextUnit[];
}

export interface AlignmentRow {
  id: string;
  left?: TextUnit;
  right?: TextUnit;
  status: DifferenceStatus;
  similarity: number;
  note: string;
  source: string;
  accepted: boolean;
  manuallyAdjusted: boolean;
  /** 比较规则变化后，自动判断与当前判断不一致，需要重新确认 */
  needsReview: boolean;
  /** 待复核时，规则重算给出的建议类别 */
  suggestedStatus?: DifferenceStatus;
}

export interface ComparisonRules {
  ignorePunctuation: boolean;
  ignoreVariants: boolean;
  candidateWindow: number;
}

/**
 * 版本快照：把校勘记录、比较规则与句段编号接在一起保存。
 * 规则变化只让受影响的记录进入待复核，原校记与来源保留。
 */
export interface CollationSnapshot {
  version: number;
  savedAt: string;
  versions: VersionDocument[];
  leftVersionId: string;
  rightVersionId: string;
  rows: AlignmentRow[];
  rules: ComparisonRules;
  selectedRowId: string;
  /** 待整理区：缺编号被补齐的句段 id */
  pendingOrganize: string[];
}
