import crypto from 'node:crypto';
import type { TurnInput } from '../engine/types.js';
import { t } from '../i18n.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import type { TelegramCallbackEvent, TelegramTextEvent } from '../telegram/gateway.js';
import { summarizeTelegramInput } from '../telegram/media.js';
import type { AppLocale, QueuedTurnInputRecord, ThreadBinding } from '../types.js';
import type { TurnRegistry } from './bridge_runtime.js';
import type { TelegramMessageService, InlineKeyboard } from './telegram_message_service.js';
import { formatUserError, inferTelegramChatType } from './utils.js';

interface TurnQueueHost {
  store: BridgeStore;
  logger: Logger;
  turns: TurnRegistry;
  messages: TelegramMessageService;
  localeForChat: (scopeId: string) => AppLocale;
  updateStatus: () => void;
  syncGuidedPlanQueueDepth: (scopeId: string, queueDepth?: number) => Promise<void>;
  buildTurnInput: (
    binding: Pick<ThreadBinding, 'threadId' | 'cwd'>,
    event: Pick<TelegramTextEvent, 'text' | 'attachments'>,
    locale: AppLocale,
  ) => Promise<TurnInput[]>;
  ensureThreadReady: (scopeId: string, binding: ThreadBinding) => Promise<ThreadBinding>;
  launchTurn: (
    scopeId: string,
    chatId: string,
    chatType: string,
    topicId: number | null,
    binding: ThreadBinding,
    input: TurnInput[],
    options?: { queuedInputId?: string | null },
  ) => Promise<void>;
  answerCallback: (callbackQueryId: string, text: string) => Promise<void>;
  dismissQueuedGuidancePrompt: (queueId: string) => Promise<void>;
}

export class TurnQueueCoordinator {
  constructor(private readonly host: TurnQueueHost) {}

  async enqueueTurnInput(
    binding: ThreadBinding,
    event: TelegramTextEvent,
    locale: AppLocale,
  ): Promise<QueuedTurnInputRecord> {
    const input = await this.host.buildTurnInput(binding, event, locale);
    const sourceSummary = summarizeTelegramInput(event.text, event.attachments) || t(locale, 'queue_item_summary_fallback');
    return this.enqueuePreparedTurnInput(
      {
        scopeId: event.scopeId,
        chatId: event.chatId,
        threadId: binding.threadId,
        input,
        sourceSummary,
      },
      locale,
    );
  }

  async enqueuePreparedTurnInput(
    params: {
      scopeId: string;
      chatId: string;
      threadId: string;
      input: TurnInput[];
      sourceSummary: string;
    },
    locale: AppLocale,
  ): Promise<QueuedTurnInputRecord> {
    const queueId = crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    this.host.store.saveQueuedTurnInput({
      queueId,
      scopeId: params.scopeId,
      chatId: params.chatId,
      threadId: params.threadId,
      input: params.input,
      sourceSummary: params.sourceSummary,
      telegramMessageId: null,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    });
    const queueDepth = this.host.store.countQueuedTurnInputs(params.scopeId);
    await this.host.syncGuidedPlanQueueDepth(params.scopeId, queueDepth);
    const receiptMessageId = await this.host.messages.sendMessage(
      params.scopeId,
      renderQueuedTurnReceiptMessage(locale, queueDepth - 1),
    );
    const current = this.host.store.getQueuedTurnInput(queueId);
    if (current) {
      const updated = {
        ...current,
        telegramMessageId: receiptMessageId,
        updatedAt: Date.now(),
      };
      this.host.store.saveQueuedTurnInput(updated);
      this.host.updateStatus();
      return updated;
    }
    this.host.updateStatus();
    return {
      queueId,
      scopeId: params.scopeId,
      chatId: params.chatId,
      threadId: params.threadId,
      input: params.input,
      sourceSummary: params.sourceSummary,
      telegramMessageId: receiptMessageId,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    };
  }

  listQueuedTurnInputs(scopeId: string): QueuedTurnInputRecord[] {
    return this.host.store.listQueuedTurnInputs(scopeId).filter((record) => record.status === 'queued');
  }

  async maybeStartQueuedTurn(scopeId: string): Promise<boolean> {
    if (this.host.turns.findByScope(scopeId)) {
      return false;
    }
    if (this.host.store.listPendingApprovals(scopeId).length > 0) {
      return false;
    }
    if (this.host.store.getPendingUserInputForChat(scopeId)) {
      return false;
    }
    if (this.host.store.listOpenPlanSessions(scopeId).some((session) =>
      session.state === 'awaiting_plan_confirmation' || session.state === 'recovery_required')) {
      return false;
    }
    while (true) {
      const record = this.host.store.peekQueuedTurnInput(scopeId);
      if (!record) {
        await this.host.syncGuidedPlanQueueDepth(scopeId, 0);
        return false;
      }
      const started = await this.startQueuedTurn(record);
      if (started) {
        return true;
      }
    }
  }

  async handleQueueCommand(event: TelegramTextEvent, locale: AppLocale, args: string[]): Promise<void> {
    const action = args.join(' ').trim().toLowerCase();
    if (!action) {
      await this.showQueuePanel(event.scopeId, undefined, locale);
      return;
    }
    if (action !== 'next' && action !== 'clear') {
      await this.host.messages.sendMessage(event.scopeId, t(locale, 'usage_queue'));
      return;
    }
    const count = await this.cancelQueuedTurnInputs(event.scopeId, action);
    await this.host.syncGuidedPlanQueueDepth(event.scopeId);
    await this.host.messages.sendMessage(
      event.scopeId,
      t(locale, action === 'next' ? 'queue_cancel_next_result' : 'queue_clear_result', { value: count }),
    );
  }

  async handleQueueCallback(
    event: TelegramCallbackEvent,
    action: 'next' | 'clear',
    locale: AppLocale,
  ): Promise<void> {
    const count = await this.cancelQueuedTurnInputs(event.scopeId, action);
    await this.host.syncGuidedPlanQueueDepth(event.scopeId);
    await this.showQueuePanel(event.scopeId, event.messageId, locale);
    await this.host.answerCallback(
      event.callbackQueryId,
      t(locale, action === 'next' ? 'queue_cancel_next_result_short' : 'queue_clear_result_short', { value: count }),
    );
  }

  async showQueuePanel(scopeId: string, messageId?: number, locale = this.host.localeForChat(scopeId)): Promise<void> {
    const queued = this.listQueuedTurnInputs(scopeId);
    const text = renderQueueStatusMessage(locale, {
      activeTurnId: this.host.turns.findByScope(scopeId)?.turnId ?? null,
      queueDepth: queued.length,
      items: queued,
    });
    const keyboard = queued.length > 0 ? queueControlKeyboard(locale) : [];
    if (messageId !== undefined) {
      await this.host.messages.editMessage(scopeId, messageId, text, keyboard);
      return;
    }
    await this.host.messages.sendMessage(scopeId, text, keyboard);
  }

  async recoverQueuedTurns(): Promise<void> {
    const scopeIds = this.host.store.listQueuedTurnInputs()
      .filter((record) => record.status === 'queued')
      .map((record) => record.scopeId)
      .filter((scopeId, index, values) => values.indexOf(scopeId) === index);
    for (const scopeId of scopeIds) {
      await this.maybeStartQueuedTurn(scopeId);
    }
  }

  private async startQueuedTurn(record: QueuedTurnInputRecord): Promise<boolean> {
    const locale = this.host.localeForChat(record.scopeId);
    await this.host.dismissQueuedGuidancePrompt(record.queueId);
    this.host.store.updateQueuedTurnInputStatus(record.queueId, 'processing');
    await this.host.syncGuidedPlanQueueDepth(record.scopeId);
    try {
      const binding = await this.host.ensureThreadReady(record.scopeId, {
        chatId: record.scopeId,
        threadId: record.threadId,
        cwd: this.host.store.getBinding(record.scopeId)?.cwd ?? null,
        updatedAt: Date.now(),
      });
      await this.host.messages.sendTyping(record.scopeId);
      const target = parseScopeId(record.scopeId);
      await this.host.launchTurn(
        record.scopeId,
        target.chatId,
        inferTelegramChatType(target.chatId),
        target.topicId,
        binding,
        record.input as TurnInput[],
        { queuedInputId: record.queueId },
      );
      return true;
    } catch (error) {
      this.host.store.updateQueuedTurnInputStatus(record.queueId, 'failed');
      await this.host.syncGuidedPlanQueueDepth(record.scopeId);
      await this.host.messages.sendMessage(record.scopeId, t(locale, 'queue_start_failed', { error: formatUserError(error) }));
      this.host.logger.warn('queue.start_failed', {
        scopeId: record.scopeId,
        queueId: record.queueId,
        error: String(error),
      });
      return false;
    }
  }

  private async cancelQueuedTurnInputs(scopeId: string, mode: 'next' | 'clear'): Promise<number> {
    const queued = this.listQueuedTurnInputs(scopeId);
    const targets = mode === 'next' ? queued.slice(0, 1) : queued;
    for (const record of targets) {
      await this.host.dismissQueuedGuidancePrompt(record.queueId);
      this.host.store.updateQueuedTurnInputStatus(record.queueId, 'cancelled');
    }
    return targets.length;
  }
}

function renderQueuedTurnReceiptMessage(locale: AppLocale, aheadCount: number): string {
  return aheadCount > 0
    ? t(locale, 'queue_receipt_with_ahead', { value: aheadCount })
    : t(locale, 'queue_receipt_next');
}

function renderQueueStatusMessage(
  locale: AppLocale,
  state: {
    activeTurnId: string | null;
    queueDepth: number;
    items: QueuedTurnInputRecord[];
  },
): string {
  const lines = [
    t(locale, 'queue_panel_title'),
    t(locale, 'queue_panel_active_turn', { value: state.activeTurnId ?? t(locale, 'none') }),
    t(locale, 'queue_panel_depth', { value: state.queueDepth }),
  ];
  if (state.items.length === 0) {
    lines.push(t(locale, 'queue_panel_empty'));
    return lines.join('\n');
  }
  lines.push(t(locale, 'queue_panel_list_title'));
  state.items.slice(0, 5).forEach((item, index) => {
    lines.push(`${index + 1}. ${item.sourceSummary || t(locale, 'queue_item_summary_fallback')}`);
  });
  if (state.items.length > 5) {
    lines.push(t(locale, 'queue_panel_more_items', { value: state.items.length - 5 }));
  }
  return lines.join('\n');
}

function queueControlKeyboard(locale: AppLocale): InlineKeyboard {
  return [[
    { text: t(locale, 'button_queue_cancel_next'), callback_data: 'queue:next' },
    { text: t(locale, 'button_queue_clear'), callback_data: 'queue:clear' },
  ]];
}

function parseScopeId(scopeId: string): { chatId: string; topicId: number | null } {
  const topicSeparator = scopeId.indexOf(':');
  if (topicSeparator === -1) {
    return { chatId: scopeId, topicId: null };
  }
  return {
    chatId: scopeId.slice(0, topicSeparator),
    topicId: Number.parseInt(scopeId.slice(topicSeparator + 1), 10),
  };
}
