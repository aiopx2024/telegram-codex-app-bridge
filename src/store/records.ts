export interface ActiveTurnPreviewRecord {
  turnId: string;
  scopeId: string;
  threadId: string;
  messageId: number;
  createdAt: number;
  updatedAt: number;
}

export interface ThreadHistoryPreviewRecord {
  scopeId: string;
  threadId: string;
  messageId: number;
  createdAt: number;
  updatedAt: number;
}

export interface HistoricalCleanupOptions {
  maxResolvedAgeMs: number;
  maxResolvedPlanSessionsPerChat: number;
}

export interface HistoricalCleanupResult {
  deletedPlanSessions: number;
  deletedPlanSnapshots: number;
  deletedPendingApprovals: number;
  deletedPendingUserInputs: number;
  deletedPendingUserInputMessages: number;
  deletedQueuedTurnInputs: number;
}
