import type { CodexAppClient } from '../codex_app/client.js';
import { t } from '../i18n.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import type { AccountRateLimitSnapshot, AppLocale } from '../types.js';
import {
  formatAccessPresetLabel,
  formatApprovalPolicyLabel,
  formatCollaborationModeLabel,
  formatSandboxModeLabel,
  formatServiceTierLabel,
} from './presentation.js';
import type { TelegramMessageService } from './telegram_message_service.js';

interface StatusCommandHost {
  store: BridgeStore;
  logger: Logger;
  app: CodexAppClient;
  messages: TelegramMessageService;
  activeTurnCount: () => number;
  localeForChat: (scopeId: string) => AppLocale;
  resolveEffectiveAccess: (scopeId: string) => { preset: string; approvalPolicy: string; sandboxMode: string };
  updateStatus: () => void;
  config: {
    codexAppSyncOnOpen: boolean;
    codexAppSyncOnTurnComplete: boolean;
  };
}

export class StatusCommandCoordinator {
  constructor(private readonly host: StatusCommandHost) {}

  async showStatus(scopeId: string, locale = this.host.localeForChat(scopeId)): Promise<void> {
    const binding = this.host.store.getBinding(scopeId);
    const settings = this.host.store.getChatSettings(scopeId);
    const access = this.host.resolveEffectiveAccess(scopeId);
    const rateLimits = await this.readStatusRateLimits();
    this.host.updateStatus();
    const lines = [
      t(locale, 'status_connected', { value: t(locale, this.host.app.isConnected() ? 'yes' : 'no') }),
      t(locale, 'status_user_agent', { value: this.host.app.getUserAgent() ?? t(locale, 'unknown') }),
      t(locale, 'status_current_thread', { value: binding?.threadId ?? t(locale, 'none') }),
      t(locale, 'status_configured_model', { value: settings?.model ?? t(locale, 'server_default') }),
      t(locale, 'status_configured_effort', { value: settings?.reasoningEffort ?? t(locale, 'server_default') }),
      t(locale, 'status_configured_service_tier', { value: formatServiceTierLabel(locale, settings?.serviceTier ?? null) }),
      t(locale, 'status_mode', { value: formatCollaborationModeLabel(locale, settings?.collaborationMode ?? null) }),
      ...formatRateLimitStatusLines(locale, rateLimits),
      t(locale, 'status_confirm_plan_before_execute', {
        value: t(locale, (settings?.confirmPlanBeforeExecute ?? true) ? 'yes' : 'no'),
      }),
      t(locale, 'status_auto_queue_messages', {
        value: t(locale, (settings?.autoQueueMessages ?? true) ? 'yes' : 'no'),
      }),
      t(locale, 'status_persist_plan_history', {
        value: t(locale, (settings?.persistPlanHistory ?? true) ? 'yes' : 'no'),
      }),
      t(locale, 'status_access_preset', { value: formatAccessPresetLabel(locale, access.preset as any) }),
      t(locale, 'status_approval_policy', { value: formatApprovalPolicyLabel(locale, access.approvalPolicy as any) }),
      t(locale, 'status_sandbox_mode', { value: formatSandboxModeLabel(locale, access.sandboxMode as any) }),
      t(locale, 'status_sync_on_open', { value: t(locale, this.host.config.codexAppSyncOnOpen ? 'yes' : 'no') }),
      t(locale, 'status_sync_on_turn_complete', { value: t(locale, this.host.config.codexAppSyncOnTurnComplete ? 'yes' : 'no') }),
      t(locale, 'status_pending_approvals', { value: this.host.store.countPendingApprovals() }),
      t(locale, 'status_pending_user_inputs', { value: this.host.store.countPendingUserInputs() }),
      t(locale, 'status_queue_depth', { value: this.host.store.countQueuedTurnInputs(scopeId) }),
      t(locale, 'status_active_turns', { value: this.host.activeTurnCount() }),
    ];
    await this.host.messages.sendMessage(scopeId, lines.join('\n'));
  }

  private async readStatusRateLimits(): Promise<AccountRateLimitSnapshot | null> {
    const app = this.host.app as {
      getAccountRateLimits?: () => AccountRateLimitSnapshot | null;
      readAccountRateLimits?: () => Promise<AccountRateLimitSnapshot | null>;
    };
    if (!this.host.app.isConnected()) {
      return typeof app.getAccountRateLimits === 'function' ? app.getAccountRateLimits() : null;
    }
    if (typeof app.readAccountRateLimits !== 'function') {
      return typeof app.getAccountRateLimits === 'function' ? app.getAccountRateLimits() : null;
    }
    try {
      return await app.readAccountRateLimits();
    } catch (error) {
      this.host.logger.warn('codex.account_rate_limits_status_failed', { error: String(error) });
      return typeof app.getAccountRateLimits === 'function' ? app.getAccountRateLimits() : null;
    }
  }
}

function formatRateLimitStatusLines(locale: AppLocale, snapshot: AccountRateLimitSnapshot | null): string[] {
  if (!snapshot) {
    return [t(locale, 'status_rate_limits_unavailable')];
  }
  const lines = [
    t(locale, 'status_account_plan', { value: snapshot.planType ?? t(locale, 'unknown') }),
  ];
  const windows = [snapshot.primary, snapshot.secondary]
    .filter((window): window is NonNullable<AccountRateLimitSnapshot['primary']> => Boolean(window))
    .sort((left, right) => (left.windowDurationMins ?? Number.MAX_SAFE_INTEGER) - (right.windowDurationMins ?? Number.MAX_SAFE_INTEGER));
  for (const window of windows) {
    lines.push(t(locale, 'status_rate_limit_window', {
      label: formatRateLimitWindowLabel(locale, window.windowDurationMins),
      used: window.usedPercent,
      reset: formatRateLimitResetAt(locale, window.resetsAt),
    }));
  }
  if (snapshot.credits && (snapshot.credits.unlimited || snapshot.credits.hasCredits || snapshot.credits.balance !== null)) {
    lines.push(t(locale, 'status_rate_limit_credits', {
      value: snapshot.credits.unlimited
        ? t(locale, 'status_rate_limit_unlimited')
        : snapshot.credits.balance ?? '0',
    }));
  }
  return lines;
}

function formatRateLimitWindowLabel(locale: AppLocale, windowDurationMins: number | null): string {
  if (windowDurationMins === 300) {
    return locale === 'zh' ? '5小时' : '5h';
  }
  if (windowDurationMins === 10080) {
    return locale === 'zh' ? '本周' : 'weekly';
  }
  if (windowDurationMins === null || !Number.isFinite(windowDurationMins) || windowDurationMins <= 0) {
    return t(locale, 'unknown');
  }
  if (windowDurationMins % 1440 === 0) {
    const days = Math.floor(windowDurationMins / 1440);
    return locale === 'zh' ? `${days}天` : `${days}d`;
  }
  if (windowDurationMins % 60 === 0) {
    const hours = Math.floor(windowDurationMins / 60);
    return locale === 'zh' ? `${hours}小时` : `${hours}h`;
  }
  return locale === 'zh' ? `${windowDurationMins}分钟` : `${windowDurationMins}m`;
}

function formatRateLimitResetAt(locale: AppLocale, resetsAt: number | null): string {
  if (resetsAt === null || !Number.isFinite(resetsAt) || resetsAt <= 0) {
    return t(locale, 'unknown');
  }
  return new Date(resetsAt * 1000).toISOString();
}
