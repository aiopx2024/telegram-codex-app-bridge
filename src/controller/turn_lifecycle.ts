import { t } from '../i18n.js';
import type { Logger } from '../logger.js';
import type { AppLocale } from '../types.js';
import { resolveTelegramRenderRoute, type TelegramRenderRoute } from '../telegram/rendering.js';
import { chunkTelegramMessage } from '../telegram/text.js';
import type { GuidedPlanTurnState } from './guided_plan.js';
import type { ToolBatchState, TurnRenderingState, TurnSegmentState } from './turn_rendering.js';

export interface ActiveTurnLifecycleState extends TurnRenderingState, GuidedPlanTurnState {
  chatId: string;
  topicId: number | null;
  renderRoute: TelegramRenderRoute;
  queuedInputId: string | null;
  buffer: string;
  finalText: string | null;
  segments: TurnSegmentState[];
  resolver: () => void;
}

interface StoredPreviewRecord {
  scopeId: string;
  messageId: number;
  threadId: string;
  turnId: string;
}

interface TurnLifecycleHost {
  logger: Logger;
  codexAppSyncOnTurnComplete: boolean;
  localeForChat: (scopeId: string) => AppLocale;
  setActiveTurn: (turnId: string, active: ActiveTurnLifecycleState) => void;
  deleteActiveTurn: (turnId: string) => void;
  listActiveTurns: () => ActiveTurnLifecycleState[];
  savePreviewRecord: (turnId: string, scopeId: string, threadId: string, messageId: number) => void;
  listStoredPreviews: () => StoredPreviewRecord[];
  queueRender: (
    active: ActiveTurnLifecycleState,
    options?: { forceStatus?: boolean; forceStream?: boolean },
  ) => Promise<void>;
  clearRenderRetry: (active: ActiveTurnLifecycleState) => void;
  clearToolBatchTimer: (batch: ToolBatchState | null) => void;
  cleanupFinishedPreview: (
    active: Pick<ActiveTurnLifecycleState, 'scopeId' | 'previewMessageId' | 'turnId' | 'interruptRequested' | 'previewActive'>,
    locale: AppLocale,
  ) => Promise<void>;
  retirePreviewMessage: (scopeId: string, messageId: number, text: string, turnId?: string) => Promise<void>;
  sendMessage: (scopeId: string, text: string) => Promise<number>;
  renderPlanCard: (active: ActiveTurnLifecycleState) => Promise<void>;
  finalizeGuidedPlanTurn: (active: ActiveTurnLifecycleState) => Promise<void>;
  markQueuedTurnCompleted: (queueId: string) => void;
  syncGuidedPlanQueueDepth: (scopeId: string) => Promise<void>;
  tryRevealThread: (
    scopeId: string,
    threadId: string,
    reason: 'open' | 'reveal' | 'turn-complete',
  ) => Promise<string | null>;
  updateStatus: () => void;
  autostartQueuedTurn: (scopeId: string) => Promise<void>;
  handleAsyncError: (source: string, error: unknown, scopeId?: string) => Promise<void>;
}

export class TurnLifecycleCoordinator {
  constructor(private readonly host: TurnLifecycleHost) {}

  async registerTurn(
    scopeId: string,
    chatId: string,
    chatType: string,
    topicId: number | null,
    threadId: string,
    turnId: string,
    previewMessageId: number,
    options: { guidedPlanSessionId?: string | null; guidedPlanDraftOnly?: boolean; queuedInputId?: string | null } = {},
  ): Promise<void> {
    let resolveTurn!: () => void;
    const waitForTurn = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    const active: ActiveTurnLifecycleState = {
      scopeId,
      chatId,
      topicId,
      renderRoute: resolveTelegramRenderRoute(chatType, topicId),
      threadId,
      turnId,
      queuedInputId: options.queuedInputId ?? null,
      previewMessageId,
      previewActive: previewMessageId > 0,
      draftId: null,
      draftText: null,
      buffer: '',
      finalText: null,
      interruptRequested: false,
      statusMessageText: null,
      statusNeedsRebase: false,
      segments: [],
      reasoningActiveCount: 0,
      pendingApprovalKinds: new Set(),
      pendingUserInputId: null,
      toolBatch: null,
      pendingArchivedStatus: null,
      planMessageId: null,
      planText: null,
      planExplanation: null,
      planSteps: [],
      planDraftText: null,
      planLastRenderedAt: 0,
      planRenderRequested: false,
      forcePlanRender: false,
      planRenderTask: null,
      guidedPlanSessionId: options.guidedPlanSessionId ?? null,
      guidedPlanDraftOnly: Boolean(options.guidedPlanDraftOnly),
      guidedPlanExecutionBlocked: false,
      renderRetryTimer: null,
      lastStreamFlushAt: 0,
      renderRequested: false,
      forceStatusFlush: false,
      forceStreamFlush: false,
      renderTask: null,
      resolver: resolveTurn,
    };
    this.host.setActiveTurn(turnId, active);
    if (previewMessageId > 0) {
      this.host.savePreviewRecord(turnId, scopeId, threadId, previewMessageId);
    }
    this.host.updateStatus();
    try {
      await this.host.queueRender(active, { forceStatus: true, forceStream: true });
    } catch (error) {
      this.host.logger.warn('telegram.preview_keyboard_attach_failed', { error: String(error), turnId });
    }
    await waitForTurn;
  }

  async handleTurnCompleted(active: ActiveTurnLifecycleState): Promise<void> {
    try {
      await this.completeTurn(active);
      await this.host.finalizeGuidedPlanTurn(active);
      if (this.host.codexAppSyncOnTurnComplete) {
        const revealError = await this.host.tryRevealThread(active.scopeId, active.threadId, 'turn-complete');
        if (revealError) {
          this.host.logger.warn('codex.reveal_thread_failed', {
            scopeId: active.scopeId,
            threadId: active.threadId,
            reason: 'turn-complete',
            error: revealError,
          });
        }
      }
    } finally {
      await this.settleCompletedTurn(active);
    }
  }

  async cleanupStaleTurnPreviews(): Promise<void> {
    for (const preview of this.host.listStoredPreviews()) {
      await this.host.retirePreviewMessage(
        preview.scopeId,
        preview.messageId,
        t(this.host.localeForChat(preview.scopeId), 'stale_preview_restarted', { threadId: preview.threadId }),
        preview.turnId,
      );
    }
  }

  async abandonAllTurns(): Promise<void> {
    const activeTurns = this.host.listActiveTurns();
    for (const active of activeTurns) {
      this.host.clearToolBatchTimer(active.toolBatch);
      this.host.clearRenderRetry(active);
      if (active.previewActive) {
        await this.host.retirePreviewMessage(
          active.scopeId,
          active.previewMessageId,
          t(this.host.localeForChat(active.scopeId), 'stale_preview_expired'),
          active.turnId,
        );
      }
      active.resolver();
      this.host.deleteActiveTurn(active.turnId);
    }
    if (activeTurns.length > 0) {
      this.host.updateStatus();
    }
  }

  private async completeTurn(active: ActiveTurnLifecycleState): Promise<void> {
    const locale = this.host.localeForChat(active.scopeId);
    let shouldMarkPartialOutput = false;
    try {
      await this.host.renderPlanCard(active);
      await this.host.queueRender(active, { forceStatus: true, forceStream: true });
      const renderedMessages = active.segments.reduce((count, segment) => count + segment.messages.length, 0);
      if (renderedMessages === 0) {
        const fallbackKey = active.interruptRequested ? 'interrupted' : 'completed';
        const finalChunks = chunkTelegramMessage(active.finalText || active.buffer, undefined, t(locale, fallbackKey));
        for (const chunk of finalChunks) {
          await this.host.sendMessage(active.scopeId, chunk);
        }
      }
      shouldMarkPartialOutput = active.interruptRequested
        && (renderedMessages > 0 || Boolean((active.finalText || active.buffer).trim()));
    } finally {
      this.host.clearRenderRetry(active);
      await this.host.cleanupFinishedPreview(active, locale);
    }
    if (shouldMarkPartialOutput) {
      await this.host.sendMessage(active.scopeId, t(locale, 'interrupted_partial_output'));
    }
    if (active.queuedInputId) {
      this.host.markQueuedTurnCompleted(active.queuedInputId);
      await this.host.syncGuidedPlanQueueDepth(active.scopeId);
    }
  }

  private async settleCompletedTurn(active: ActiveTurnLifecycleState): Promise<void> {
    active.resolver();
    this.host.deleteActiveTurn(active.turnId);
    this.host.updateStatus();
    try {
      await this.host.autostartQueuedTurn(active.scopeId);
    } catch (error) {
      await this.host.handleAsyncError('queue.autostart', error, active.scopeId);
    }
  }
}
