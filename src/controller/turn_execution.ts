import { t } from '../i18n.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import type { TelegramCallbackEvent } from '../telegram/gateway.js';
import type { AppLocale, PendingApprovalRecord, ThreadBinding } from '../types.js';
import type { CodexAppClient, TurnInput } from '../codex_app/client.js';
import type { TurnRegistry } from './bridge_runtime.js';
import type { ActiveTurn } from './turn_state.js';
import { PLAN_MODE_DRAFT_ONLY_DEVELOPER_INSTRUCTIONS, type GuidedPlanCoordinator } from './guided_plan.js';
import type { TurnRenderingCoordinator } from './turn_rendering.js';
import { ensureTurnSegment } from './turn_rendering.js';
import type { TurnLifecycleCoordinator } from './turn_lifecycle.js';
import type { TelegramMessageService } from './telegram_message_service.js';
import type { StatusPreviewCoordinator } from './status_preview.js';
import { formatUserError } from './utils.js';

interface TurnExecutionHost {
  logger: Logger;
  store: BridgeStore;
  app: Pick<CodexAppClient, 'interruptTurn' | 'respond'>;
  turns: TurnRegistry;
  localeForChat: (scopeId: string) => AppLocale;
  shouldRequirePlanConfirmation: (scopeId: string) => boolean;
  messages: TelegramMessageService;
  answerCallback: (callbackQueryId: string, text: string) => Promise<void>;
  handleAsyncError: (source: string, error: unknown, scopeId?: string) => Promise<void>;
  guidedPlans: Pick<GuidedPlanCoordinator, 'createSession' | 'syncTurnPlan' | 'queuePlanRender'>;
  turnRendering: Pick<
    TurnRenderingCoordinator,
    'queueRender' | 'noteToolCommandStart' | 'noteToolCommandEnd' | 'promoteReadyToolBatch' | 'findStreamingSegment'
  >;
  turnLifecycle: Pick<TurnLifecycleCoordinator, 'registerTurn' | 'handleTurnCompleted'>;
  statusPreview: Pick<StatusPreviewCoordinator, 'cleanupStaleInterruptButton'>;
  startTurnWithRecovery: (
    scopeId: string,
    binding: Pick<ThreadBinding, 'threadId' | 'cwd'>,
    input: TurnInput[],
    options?: {
      developerInstructions?: string | null;
      accessOverride?: { approvalPolicy: string; sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access' };
      collaborationModeOverride?: 'plan' | null;
    },
  ) => Promise<{ threadId: string; turnId: string }>;
  onStatusChanged: () => void;
}

export class TurnExecutionCoordinator {
  constructor(private readonly host: TurnExecutionHost) {}

  async startIncomingTurn(
    scopeId: string,
    chatId: string,
    chatType: string,
    topicId: number | null,
    binding: ThreadBinding,
    input: TurnInput[],
    options: { queuedInputId?: string | null } = {},
  ): Promise<void> {
    const requiresPlanConfirmation = this.host.shouldRequirePlanConfirmation(scopeId);
    const turnState = await this.host.startTurnWithRecovery(
      scopeId,
      binding,
      input,
      requiresPlanConfirmation
        ? {
            developerInstructions: PLAN_MODE_DRAFT_ONLY_DEVELOPER_INSTRUCTIONS,
            accessOverride: {
              approvalPolicy: 'on-request',
              sandboxMode: 'read-only',
            },
          }
        : {},
    );
    let guidedPlanSessionId: string | null = null;
    if (requiresPlanConfirmation) {
      guidedPlanSessionId = this.host.guidedPlans.createSession(scopeId, turnState.threadId, turnState.turnId);
    }
    this.launchRegisteredTurn(
      scopeId,
      chatId,
      chatType,
      topicId,
      turnState.threadId,
      turnState.turnId,
      0,
      {
        guidedPlanSessionId,
        guidedPlanDraftOnly: requiresPlanConfirmation,
        queuedInputId: options.queuedInputId ?? null,
      },
    );
  }

  launchRegisteredTurn(
    scopeId: string,
    chatId: string,
    chatType: string,
    topicId: number | null,
    threadId: string,
    turnId: string,
    previewMessageId: number,
    options: { guidedPlanSessionId?: string | null; guidedPlanDraftOnly?: boolean; queuedInputId?: string | null } = {},
  ): void {
    void this.host.turnLifecycle.registerTurn(
      scopeId,
      chatId,
      chatType,
      topicId,
      threadId,
      turnId,
      previewMessageId,
      options,
    ).catch((error) => {
      void this.host.handleAsyncError(options.queuedInputId ? 'queue.start' : 'telegram.turn_start', error, scopeId);
    });
  }

  async handleTurnActivityEvent(activity: any): Promise<void> {
    const active = this.host.turns.get(activity.turnId);
    if (!active) {
      return;
    }

    switch (activity.kind) {
      case 'agent_message_started': {
        this.host.turnRendering.promoteReadyToolBatch(active);
        ensureTurnSegment(active, activity.itemId, activity.phase, activity.outputKind);
        await this.host.turnRendering.queueRender(active, { forceStatus: true });
        return;
      }
      case 'agent_message_delta': {
        const segment = ensureTurnSegment(active, activity.itemId, undefined, activity.outputKind);
        segment.text += activity.delta;
        active.buffer += activity.delta;
        await this.host.turnRendering.queueRender(active);
        return;
      }
      case 'agent_message_completed': {
        const segment = ensureTurnSegment(active, activity.itemId, activity.phase, activity.outputKind);
        if (activity.text !== null) {
          segment.text = activity.text || segment.text;
          if (activity.outputKind === 'final_answer') {
            active.finalText = activity.text || active.buffer || t(this.host.localeForChat(active.scopeId), 'completed');
          }
        }
        segment.completed = true;
        await this.host.turnRendering.queueRender(active, { forceStream: true, forceStatus: true });
        return;
      }
      case 'reasoning_started': {
        this.host.turnRendering.promoteReadyToolBatch(active);
        active.reasoningActiveCount += 1;
        await this.host.turnRendering.queueRender(active, { forceStatus: true });
        return;
      }
      case 'reasoning_completed': {
        active.reasoningActiveCount = Math.max(0, active.reasoningActiveCount - 1);
        await this.host.turnRendering.queueRender(active, { forceStatus: true });
        return;
      }
      case 'tool_started': {
        this.host.turnRendering.noteToolCommandStart(active, activity.exec);
        await this.host.turnRendering.queueRender(active, { forceStatus: true });
        return;
      }
      case 'tool_completed': {
        this.host.turnRendering.noteToolCommandEnd(active, activity.exec);
        await this.host.turnRendering.queueRender(active, { forceStatus: true });
        return;
      }
      case 'turn_completed': {
        this.host.turnRendering.promoteReadyToolBatch(active);
        await this.host.turnLifecycle.handleTurnCompleted(active);
      }
    }
  }

  async rejectDraftOnlyApprovalRequestIfNeeded(serverRequestId: string | number, params: any): Promise<boolean> {
    const turnId = typeof params?.turnId === 'string' ? params.turnId : String(params?.turnId || '');
    if (!turnId) {
      return false;
    }
    const active = this.host.turns.get(turnId);
    if (!active?.guidedPlanDraftOnly) {
      return false;
    }
    active.guidedPlanExecutionBlocked = true;
    await this.host.app.respond(serverRequestId, { decision: 'decline' });
    await this.host.messages.sendMessage(active.scopeId, t(this.host.localeForChat(active.scopeId), 'plan_draft_execution_blocked'));
    if (!active.interruptRequested) {
      try {
        await this.requestInterrupt(active);
      } catch (error) {
        this.host.logger.warn('guided_plan.draft_interrupt_failed', {
          turnId: active.turnId,
          error: String(error),
        });
      }
    }
    return true;
  }

  async handleTurnInterruptCallback(event: TelegramCallbackEvent, turnId: string, locale: AppLocale): Promise<void> {
    const active = this.host.turns.get(turnId);
    if (!active || active.scopeId !== event.scopeId) {
      await this.host.statusPreview.cleanupStaleInterruptButton(event.scopeId, event.messageId, locale);
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'turn_already_finished'));
      return;
    }
    if (active.interruptRequested) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'interrupt_already_requested'));
      return;
    }
    active.interruptRequested = true;
    try {
      await this.requestInterrupt(active);
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'interrupt_requested'));
    } catch (error) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'interrupt_failed', { error: formatUserError(error) }));
    }
  }

  async handleInterruptCommand(scopeId: string, locale: AppLocale): Promise<boolean> {
    const active = this.host.turns.findByScope(scopeId);
    if (!active) {
      await this.host.messages.sendMessage(scopeId, t(locale, 'no_active_turn'));
      return false;
    }
    await this.requestInterrupt(active);
    await this.host.messages.sendMessage(scopeId, t(locale, 'interrupt_requested_for', { turnId: active.turnId }));
    return true;
  }

  async notePendingApprovalStatus(threadId: string, kind: PendingApprovalRecord['kind']): Promise<void> {
    const active = this.host.turns.findByThreadId(threadId);
    if (!active) {
      return;
    }
    active.pendingApprovalKinds.add(kind);
    await this.host.turnRendering.queueRender(active, { forceStatus: true });
  }

  async clearPendingApprovalStatus(threadId: string, kind: PendingApprovalRecord['kind']): Promise<void> {
    const active = this.host.turns.findByThreadId(threadId);
    if (!active) {
      return;
    }
    active.pendingApprovalKinds.delete(kind);
    await this.host.turnRendering.queueRender(active, { forceStatus: true });
  }

  async notePendingUserInputStatus(threadId: string, localId: string): Promise<void> {
    const active = this.host.turns.findByThreadId(threadId);
    if (!active) {
      return;
    }
    active.pendingUserInputId = localId;
    await this.host.turnRendering.queueRender(active, { forceStatus: true });
  }

  async clearPendingUserInputStatus(threadId: string, localId: string): Promise<void> {
    const active = this.host.turns.findByThreadId(threadId);
    if (!active || active.pendingUserInputId !== localId) {
      return;
    }
    active.pendingUserInputId = null;
    await this.host.turnRendering.queueRender(active, { forceStatus: true });
  }

  async syncTurnPlan(active: ActiveTurn, params: any): Promise<void> {
    await this.host.guidedPlans.syncTurnPlan(active, params);
  }

  findStreamingSegment(active: ActiveTurn) {
    return this.host.turnRendering.findStreamingSegment(active);
  }

  private async requestInterrupt(active: ActiveTurn): Promise<void> {
    active.interruptRequested = true;
    try {
      await this.host.app.interruptTurn(active.threadId, active.turnId);
      await this.host.turnRendering.queueRender(active, { forceStatus: true, forceStream: true });
    } catch (error) {
      active.interruptRequested = false;
      throw error;
    }
  }
}
