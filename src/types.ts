export interface ThreadBinding {
  chatId: string;
  threadId: string;
  cwd: string | null;
  updatedAt: number;
}

export interface CachedThread {
  index: number;
  threadId: string;
  preview: string;
  cwd: string | null;
  updatedAt: number;
}

export type ApprovalKind = 'command' | 'fileChange';

export interface PendingApprovalRecord {
  localId: string;
  serverRequestId: string;
  kind: ApprovalKind;
  chatId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId: string | null;
  reason: string | null;
  command: string | null;
  cwd: string | null;
  messageId: number | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface RuntimeStatus {
  running: boolean;
  connected: boolean;
  userAgent: string | null;
  botUsername: string | null;
  currentBindings: number;
  pendingApprovals: number;
  activeTurns: number;
  lastError: string | null;
  updatedAt: string;
}
