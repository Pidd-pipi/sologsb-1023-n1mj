export type DifferenceStatus = 'same' | 'changed' | 'added' | 'removed' | 'misaligned';

export interface TextUnit {
  id: string;
  paragraphId: string;
  paragraphOrder: number;
  sentenceOrder: number;
  paragraphText: string;
  text: string;
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
  /** 句段编号：发放后不再变化，跨快照沿用 */
  seq: number;
  left?: TextUnit;
  right?: TextUnit;
  status: DifferenceStatus;
  similarity: number;
  note: string;
  source: string;
  accepted: boolean;
  manuallyAdjusted: boolean;
  /** 比较规则调整后判断发生变化，等待人工复核 */
  needsReview?: boolean;
  reviewReason?: string;
  /** 旧稿缺句段编号，兼容补齐后进入待整理区 */
  unfiled?: boolean;
}

export interface ComparisonRules {
  ignorePunctuation: boolean;
  ignoreVariants: boolean;
  candidateWindow: number;
}

export interface CollationSnapshot {
  id: string;
  name: string;
  createdAt: string;
  leftVersionId: string;
  rightVersionId: string;
  /** 快照保存时的比较规则，与校勘记录一起固化 */
  rules: ComparisonRules;
  rows: AlignmentRow[];
  differenceCount: number;
}

export interface PersistedCollationState {
  schemaVersion?: number;
  versions: VersionDocument[];
  leftVersionId: string;
  rightVersionId: string;
  rows: AlignmentRow[];
  rules: ComparisonRules;
  selectedRowId: string;
  snapshots?: CollationSnapshot[];
  /** 句段编号发号器，持久化以保证跨会话不重复发号 */
  nextSeq?: number;
}
