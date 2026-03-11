import { t } from '../i18n.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import type { AppLocale } from '../types.js';
import type { ActiveTurn, ArchivedStatusContent } from './turn_state.js';
import { TelegramMessageService, type InlineKeyboard, isTelegramMessageGone } from './telegram_message_service.js';

interface StatusPreviewHost {
  logger: Logger;
  store: BridgeStore;
  messages: TelegramMessageService;
  localeForChat: (scopeId: string) => AppLocale;
  renderActiveStatus: (active: ActiveTurn) => string;
  scheduleRenderRetry: (active: ActiveTurn, delayMs?: number) => void;
  clearRenderRetry: (active: ActiveTurn) => void;
}

export class StatusPreviewCoordinator {
  constructor(private readonly host: StatusPreviewHost) {}

  async syncTurnStatus(active: ActiveTurn, force: boolean): Promise<void> {
    if (active.pendingArchivedStatus) {
      const archived = await this.archiveStatusMessage(active, active.pendingArchivedStatus);
      if (!archived) {
        return;
      }
      active.pendingArchivedStatus = null;
    }

    const text = this.host.renderActiveStatus(active);
    if (active.previewActive && active.statusNeedsRebase) {
      await this.rebaseStatusMessage(active, text);
      return;
    }
    if (!force && text === active.statusMessageText && active.previewActive) {
      return;
    }
    await this.ensureStatusMessage(active, text);
  }

  async cleanupFinishedPreview(
    active: Pick<ActiveTurn, 'scopeId' | 'previewMessageId' | 'turnId' | 'interruptRequested' | 'previewActive'>,
    locale: AppLocale,
  ): Promise<void> {
    if (!active.previewActive) {
      return;
    }
    try {
      await this.host.messages.deleteMessage(active.scopeId, active.previewMessageId);
      this.host.store.removeActiveTurnPreview(active.turnId);
      return;
    } catch (error) {
      if (isTelegramMessageGone(error)) {
        this.host.store.removeActiveTurnPreview(active.turnId);
        return;
      }
      this.host.logger.warn('telegram.preview_delete_failed', { error: String(error), turnId: active.turnId });
    }

    await this.retirePreviewMessage(
      active.scopeId,
      active.previewMessageId,
      t(locale, active.interruptRequested ? 'interrupted_see_reply_below' : 'completed_see_reply_below'),
      active.turnId,
    );
  }

  async cleanupStaleInterruptButton(scopeId: string, messageId: number, locale: AppLocale): Promise<void> {
    try {
      await this.host.messages.clearMessageButtons(scopeId, messageId);
    } catch (error) {
      if (!isTelegramMessageGone(error)) {
        this.host.logger.warn('telegram.stale_interrupt_cleanup_failed', {
          scopeId,
          messageId,
          locale,
          error: String(error),
        });
      }
    }
  }

  async dismissTurnPreview(active: ActiveTurn): Promise<void> {
    if (!active.previewActive) {
      return;
    }
    const cleared = await this.cleanupTransientPreview(active.scopeId, active.previewMessageId);
    if (!cleared) {
      this.host.scheduleRenderRetry(active);
      return;
    }
    active.previewActive = false;
    active.statusMessageText = null;
    active.statusNeedsRebase = false;
    this.host.store.removeActiveTurnPreview(active.turnId);
  }

  async ensureStatusMessage(active: ActiveTurn, text: string): Promise<void> {
    if (!active.previewActive) {
      try {
        const messageId = await this.host.messages.sendMessage(
          active.scopeId,
          text,
          active.interruptRequested ? [] : activeTurnKeyboard(this.host.localeForChat(active.scopeId), active.turnId),
        );
        active.previewMessageId = messageId;
        active.previewActive = true;
        active.statusMessageText = text;
        active.statusNeedsRebase = false;
        this.host.store.saveActiveTurnPreview({
          turnId: active.turnId,
          scopeId: active.scopeId,
          threadId: active.threadId,
          messageId,
        });
      } catch (error) {
        this.host.logger.warn('telegram.preview_send_failed', { error: String(error), turnId: active.turnId });
        this.host.scheduleRenderRetry(active);
      }
      return;
    }

    try {
      await this.host.messages.editMessage(
        active.scopeId,
        active.previewMessageId,
        text,
        active.interruptRequested ? [] : activeTurnKeyboard(this.host.localeForChat(active.scopeId), active.turnId),
      );
      active.statusMessageText = text;
      active.statusNeedsRebase = false;
      this.host.clearRenderRetry(active);
    } catch (error) {
      if (isTelegramMessageGone(error)) {
        active.previewActive = false;
        active.statusMessageText = null;
        active.statusNeedsRebase = false;
        this.host.store.removeActiveTurnPreview(active.turnId);
        await this.ensureStatusMessage(active, text);
        return;
      }
      this.host.logger.warn('telegram.preview_edit_failed', {
        error: String(error),
        turnId: active.turnId,
        messageId: active.previewMessageId,
      });
      this.host.scheduleRenderRetry(active);
    }
  }

  async rebaseStatusMessage(active: ActiveTurn, text: string): Promise<void> {
    if (active.previewActive) {
      const cleared = await this.cleanupTransientPreview(active.scopeId, active.previewMessageId);
      if (!cleared) {
        this.host.scheduleRenderRetry(active);
        return;
      }
      active.previewActive = false;
      active.statusMessageText = null;
      this.host.store.removeActiveTurnPreview(active.turnId);
    }
    active.statusNeedsRebase = false;
    await this.ensureStatusMessage(active, text);
  }

  async archiveStatusMessage(active: ActiveTurn, content: ArchivedStatusContent): Promise<boolean> {
    if (!active.previewActive) {
      try {
        if (content.html) {
          await this.host.messages.sendHtmlMessage(active.scopeId, content.html);
        } else {
          await this.host.messages.sendMessage(active.scopeId, content.text);
        }
      } catch (error) {
        this.host.logger.warn('telegram.preview_archive_send_failed', { error: String(error), turnId: active.turnId });
        this.host.scheduleRenderRetry(active);
        return false;
      }
      return true;
    }

    try {
      if (content.html) {
        await this.host.messages.editHtmlMessage(active.scopeId, active.previewMessageId, content.html, []);
      } else {
        await this.host.messages.editMessage(active.scopeId, active.previewMessageId, content.text, []);
      }
    } catch (error) {
      if (isTelegramMessageGone(error)) {
        active.previewActive = false;
        active.statusMessageText = null;
        active.statusNeedsRebase = false;
        this.host.store.removeActiveTurnPreview(active.turnId);
        return this.archiveStatusMessage(active, content);
      }
      this.host.logger.warn('telegram.preview_archive_failed', {
        error: String(error),
        turnId: active.turnId,
        messageId: active.previewMessageId,
      });
      this.host.scheduleRenderRetry(active);
      return false;
    }

    active.previewActive = false;
    active.statusMessageText = null;
    active.statusNeedsRebase = false;
    this.host.store.removeActiveTurnPreview(active.turnId);
    return true;
  }

  async retirePreviewMessage(scopeId: string, messageId: number, text: string, turnId?: string): Promise<void> {
    try {
      await this.host.messages.editMessage(scopeId, messageId, text, []);
      this.forgetPreviewRecord(scopeId, messageId, turnId);
      return;
    } catch (error) {
      if (isTelegramMessageGone(error)) {
        this.forgetPreviewRecord(scopeId, messageId, turnId);
        return;
      }
      this.host.logger.warn('telegram.preview_text_cleanup_failed', {
        scopeId,
        messageId,
        turnId: turnId ?? null,
        error: String(error),
      });
    }

    try {
      await this.host.messages.clearMessageButtons(scopeId, messageId);
      this.forgetPreviewRecord(scopeId, messageId, turnId);
    } catch (error) {
      if (isTelegramMessageGone(error)) {
        this.forgetPreviewRecord(scopeId, messageId, turnId);
        return;
      }
      this.host.logger.warn('telegram.preview_markup_cleanup_failed', {
        scopeId,
        messageId,
        turnId: turnId ?? null,
        error: String(error),
      });
    }
  }

  private forgetPreviewRecord(scopeId: string, messageId: number, turnId?: string): void {
    if (turnId) {
      this.host.store.removeActiveTurnPreview(turnId);
      return;
    }
    this.host.store.removeActiveTurnPreviewByMessage(scopeId, messageId);
  }

  private async cleanupTransientPreview(scopeId: string, messageId: number): Promise<boolean> {
    try {
      await this.host.messages.deleteMessage(scopeId, messageId);
      return true;
    } catch (error) {
      if (isTelegramMessageGone(error)) {
        return true;
      }
      this.host.logger.warn('telegram.preview_transient_cleanup_failed', { scopeId, messageId, error: String(error) });
      return false;
    }
  }
}

function activeTurnKeyboard(locale: AppLocale, turnId: string): InlineKeyboard {
  return [[
    { text: t(locale, 'button_interrupt'), callback_data: `turn:interrupt:${turnId}` },
  ]];
}
