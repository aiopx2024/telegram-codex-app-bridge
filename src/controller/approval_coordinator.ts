import crypto from 'node:crypto';
import { t } from '../i18n.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import type { EngineProvider } from '../engine/types.js';
import type { AppLocale, PendingApprovalRecord } from '../types.js';
import type { TelegramCallbackEvent } from '../telegram/gateway.js';
import {
  buildApprovalKeyboard,
  deriveApprovalDetails,
  mapApprovalDecision,
  renderApprovalDetailsMessage,
  renderApprovalMessage,
  type ApprovalAction,
  type InlineKeyboard,
} from './approval_rendering.js';

interface ApprovalHost {
  store: BridgeStore;
  logger: Logger;
  app: Pick<EngineProvider, 'respond'>;
  resolveChatByThread: (threadId: string) => string | null;
  localeForChat: (scopeId: string) => AppLocale;
  notePendingApprovalStatus: (threadId: string, kind: PendingApprovalRecord['kind']) => Promise<void>;
  clearPendingApprovalStatus: (threadId: string, kind: PendingApprovalRecord['kind']) => Promise<void>;
  sendMessage: (scopeId: string, text: string, inlineKeyboard?: InlineKeyboard) => Promise<number>;
  editMessage: (scopeId: string, messageId: number, text: string, inlineKeyboard?: InlineKeyboard) => Promise<void>;
  answerCallback: (callbackQueryId: string, text: string) => Promise<void>;
  updateStatus: () => void;
}

export class ApprovalCoordinator {
  private approvalTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly host: ApprovalHost) {}

  stop(): void {
    for (const timer of this.approvalTimers.values()) {
      clearTimeout(timer);
    }
    this.approvalTimers.clear();
  }

  async recoverPendingApprovals(): Promise<void> {
    for (const approval of this.host.store.listPendingApprovals()) {
      const locale = this.host.localeForChat(approval.chatId);
      const messageId = await this.host.sendMessage(
        approval.chatId,
        renderApprovalMessage(locale, approval),
        buildApprovalKeyboard(locale, approval.localId),
      );
      this.host.store.updatePendingApprovalMessage(approval.localId, messageId);
      this.armApprovalTimer(approval.localId);
    }
  }

  async handleApprovalRequest(
    kind: PendingApprovalRecord['kind'],
    serverRequestId: string | number,
    params: any,
  ): Promise<void> {
    const approval = this.createApprovalRecord(kind, serverRequestId, params);
    await this.host.notePendingApprovalStatus(approval.threadId, approval.kind);
    const locale = this.host.localeForChat(approval.chatId);
    const messageId = await this.host.sendMessage(
      approval.chatId,
      renderApprovalMessage(locale, approval),
      buildApprovalKeyboard(locale, approval.localId),
    );
    this.host.store.updatePendingApprovalMessage(approval.localId, messageId);
    this.armApprovalTimer(approval.localId);
    this.host.updateStatus();
  }

  async handleApprovalCallback(
    event: TelegramCallbackEvent,
    localId: string,
    action: ApprovalAction | 'details' | 'back',
    locale: AppLocale,
  ): Promise<boolean> {
    const approval = this.host.store.getPendingApproval(localId);
    if (!approval || approval.resolvedAt) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'approval_already_resolved'));
      return true;
    }
    if (approval.chatId !== event.scopeId || (approval.messageId !== null && approval.messageId !== event.messageId)) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'approval_mismatch'));
      return true;
    }
    if (action === 'details' || action === 'back') {
      if (approval.messageId !== null) {
        await this.host.editMessage(
          event.scopeId,
          approval.messageId,
          action === 'details' ? renderApprovalDetailsMessage(locale, approval) : renderApprovalMessage(locale, approval),
          buildApprovalKeyboard(locale, approval.localId, action === 'details'),
        );
      }
      await this.host.answerCallback(
        event.callbackQueryId,
        t(locale, action === 'details' ? 'approval_showing_details' : 'approval_showing_summary'),
      );
      return true;
    }

    await this.host.app.respond(approval.serverRequestId, mapApprovalDecision(action));
    this.host.store.markApprovalResolved(localId);
    this.clearApprovalTimer(localId);
    await this.host.clearPendingApprovalStatus(approval.threadId, approval.kind);
    await this.host.answerCallback(event.callbackQueryId, t(locale, 'decision_recorded'));
    if (approval.messageId !== null) {
      await this.host.editMessage(event.scopeId, approval.messageId, renderApprovalMessage(locale, approval, action));
    }
    this.host.updateStatus();
    return true;
  }

  private createApprovalRecord(kind: PendingApprovalRecord['kind'], serverRequestId: string | number, params: any): PendingApprovalRecord {
    const threadId = String(params.threadId);
    const scopeId = this.host.resolveChatByThread(threadId);
    if (!scopeId) {
      throw new Error(`No chat binding found for thread ${threadId}`);
    }
    const details = deriveApprovalDetails(kind, params);
    const record: PendingApprovalRecord = {
      localId: crypto.randomBytes(8).toString('hex'),
      serverRequestId: String(serverRequestId),
      kind,
      chatId: scopeId,
      threadId,
      turnId: String(params.turnId),
      itemId: String(params.itemId),
      approvalId: params.approvalId ? String(params.approvalId) : null,
      reason: params.reason ? String(params.reason) : null,
      command: typeof params.command === 'string'
        ? params.command
        : Array.isArray(params.command)
          ? params.command.map((part: unknown) => String(part)).join(' ')
          : null,
      cwd: params.cwd ? String(params.cwd) : null,
      summary: details.summary,
      riskLevel: details.riskLevel,
      details: details.details,
      messageId: null,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    this.host.store.savePendingApproval(record);
    return record;
  }

  private armApprovalTimer(localId: string): void {
    this.clearApprovalTimer(localId);
    const timer = setTimeout(() => {
      void this.expireApproval(localId);
    }, 5 * 60 * 1000);
    this.approvalTimers.set(localId, timer);
  }

  private clearApprovalTimer(localId: string): void {
    const timer = this.approvalTimers.get(localId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.approvalTimers.delete(localId);
  }

  private async expireApproval(localId: string): Promise<void> {
    const approval = this.host.store.getPendingApproval(localId);
    if (!approval || approval.resolvedAt) {
      this.clearApprovalTimer(localId);
      return;
    }
    try {
      await this.host.app.respond(approval.serverRequestId, { decision: 'decline' });
      this.host.store.markApprovalResolved(localId);
      await this.host.clearPendingApprovalStatus(approval.threadId, approval.kind);
      const locale = this.host.localeForChat(approval.chatId);
      if (approval.messageId !== null) {
        await this.host.editMessage(approval.chatId, approval.messageId, renderApprovalMessage(locale, approval, 'deny'));
      } else {
        await this.host.sendMessage(approval.chatId, t(locale, 'approval_timed_out_denied', { threadId: approval.threadId }));
      }
    } catch (error) {
      this.host.logger.error('approval.timeout_failed', { localId, error: String(error) });
    } finally {
      this.clearApprovalTimer(localId);
      this.host.updateStatus();
    }
  }
}
