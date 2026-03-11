import type { JsonRpcNotification, JsonRpcServerRequest, CodexAppClient } from '../codex_app/client.js';
import { t } from '../i18n.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import { normalizeTurnActivityEvent } from './activity.js';
import type { ApprovalInputCoordinator } from './approval_input.js';
import type { GuidedPlanCoordinator } from './guided_plan.js';
import type { SettingsCoordinator } from './settings.js';
import type { TurnExecutionCoordinator } from './turn_execution.js';
import type { ThreadSessionService } from './thread_session.js';
import type { TelegramMessageService } from './telegram_message_service.js';
import type { AppLocale } from '../types.js';
import type { TurnRegistry, RuntimeStatusStore } from './bridge_runtime.js';

interface CodexIngressHost {
  logger: Logger;
  store: BridgeStore;
  app: CodexAppClient;
  turns: TurnRegistry;
  approvalsAndInputs: ApprovalInputCoordinator;
  guidedPlans: GuidedPlanCoordinator;
  turnExecution: TurnExecutionCoordinator;
  settings: SettingsCoordinator;
  sessions: ThreadSessionService;
  messages: TelegramMessageService;
  localeForChat: (scopeId: string) => AppLocale;
  runtimeStatus: RuntimeStatusStore;
  updateStatus: () => void;
}

export class CodexIngressRouter {
  constructor(private readonly host: CodexIngressHost) {}

  async handleNotification(notification: JsonRpcNotification): Promise<void> {
    const activity = normalizeTurnActivityEvent(notification);
    if (activity) {
      await this.host.turnExecution.handleTurnActivityEvent(activity);
      return;
    }
    switch (notification.method) {
      case 'sessionConfigured': {
        const params = notification.params as any;
        const threadId = String(params.session_id || '');
        if (!threadId) {
          return;
        }
        const active = this.host.turns.findByThreadId(threadId);
        const scopeId = active?.scopeId ?? this.host.store.findChatIdByThreadId(threadId);
        if (!scopeId) {
          return;
        }
        this.host.sessions.handleSessionConfigured(scopeId, params);
        return;
      }
      case 'turn/plan/updated': {
        const params = notification.params as any;
        const turnId = typeof params?.turnId === 'string' ? params.turnId : null;
        if (!turnId) {
          return;
        }
        const active = this.host.turns.get(turnId);
        if (!active) {
          return;
        }
        await this.host.turnExecution.syncTurnPlan(active, params);
        return;
      }
      case 'item/plan/delta': {
        const params = notification.params as any;
        const turnId = typeof params?.turnId === 'string'
          ? params.turnId
          : typeof params?.turn_id === 'string'
            ? params.turn_id
            : null;
        const delta = typeof params?.delta === 'string' ? params.delta : null;
        if (!turnId || !delta) {
          return;
        }
        const active = this.host.turns.get(turnId);
        if (!active) {
          return;
        }
        active.planDraftText = `${active.planDraftText ?? ''}${delta}`;
        await this.host.guidedPlans.queuePlanRender(active);
        return;
      }
      case 'account/rateLimits/updated': {
        this.host.updateStatus();
        return;
      }
      case 'error': {
        this.host.runtimeStatus.setSerializedLastError(JSON.stringify(notification.params ?? {}));
        this.host.logger.error('codex.notification.error', notification.params);
        this.host.updateStatus();
      }
    }
  }

  async handleServerRequest(request: JsonRpcServerRequest): Promise<void> {
    switch (request.method) {
      case 'item/commandExecution/requestApproval': {
        const params = request.params as any;
        if (await this.host.turnExecution.rejectDraftOnlyApprovalRequestIfNeeded(request.id, params)) {
          return;
        }
        await this.host.approvalsAndInputs.handleApprovalRequest('command', request.id, params);
        return;
      }
      case 'item/fileChange/requestApproval': {
        const params = request.params as any;
        if (await this.host.turnExecution.rejectDraftOnlyApprovalRequestIfNeeded(request.id, params)) {
          return;
        }
        await this.host.approvalsAndInputs.handleApprovalRequest('fileChange', request.id, params);
        return;
      }
      case 'item/tool/requestUserInput': {
        const params = request.params as any;
        const threadId = typeof params?.threadId === 'string' ? params.threadId : String(params?.threadId || '');
        const active = threadId ? this.host.turns.findByThreadId(threadId) : null;
        const scopeId = active?.scopeId ?? (threadId ? this.host.store.findChatIdByThreadId(threadId) : null);
        if (scopeId && !this.host.settings.shouldAllowInteractiveUserInput(scopeId)) {
          const locale = this.host.localeForChat(scopeId);
          await this.host.app.respondError(
            request.id,
            'Interactive requestUserInput is only available in plan mode for this chat.',
          );
          await this.host.messages.sendMessage(scopeId, t(locale, 'input_plan_mode_only'));
          return;
        }
        await this.host.approvalsAndInputs.handlePendingUserInputRequest(request.id, params);
        return;
      }
      default:
        await this.host.app.respondError(request.id, `Unsupported server request: ${request.method}`);
    }
  }
}
