import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import type { EngineProvider } from '../engine/types.js';
import type { AppLocale, PendingApprovalRecord } from '../types.js';
import type { TelegramCallbackEvent } from '../telegram/gateway.js';
import { ApprovalCoordinator } from './approval_coordinator.js';
import { PendingUserInputCoordinator } from './pending_user_input_coordinator.js';
export {
  buildPendingUserInputResponse,
  renderAnsweredPendingUserInputMessage,
  renderApprovalDetailsMessage,
  renderApprovalMessage,
  renderCancelledPendingUserInputMessage,
  renderPendingUserInputMessage,
  renderPendingUserInputReviewMessage,
  renderResolvedPendingUserInputMessage,
  type ApprovalAction,
  type InlineKeyboard,
} from './approval_rendering.js';
import type { ApprovalAction, InlineKeyboard } from './approval_rendering.js';

interface ApprovalInputHost {
  store: BridgeStore;
  logger: Logger;
  app: Pick<EngineProvider, 'respond' | 'respondError'>;
  resolveChatByThread: (threadId: string) => string | null;
  localeForChat: (scopeId: string) => AppLocale;
  shouldAllowInteractiveUserInput: (scopeId: string) => boolean;
  notePendingApprovalStatus: (threadId: string, kind: PendingApprovalRecord['kind']) => Promise<void>;
  clearPendingApprovalStatus: (threadId: string, kind: PendingApprovalRecord['kind']) => Promise<void>;
  notePendingUserInputStatus: (threadId: string, localId: string) => Promise<void>;
  clearPendingUserInputStatus: (threadId: string, localId: string) => Promise<void>;
  sendMessage: (scopeId: string, text: string, inlineKeyboard?: InlineKeyboard) => Promise<number>;
  sendHtmlMessage: (scopeId: string, text: string, inlineKeyboard?: InlineKeyboard) => Promise<number>;
  editMessage: (scopeId: string, messageId: number, text: string, inlineKeyboard?: InlineKeyboard) => Promise<void>;
  editHtmlMessage: (scopeId: string, messageId: number, text: string, inlineKeyboard?: InlineKeyboard) => Promise<void>;
  answerCallback: (callbackQueryId: string, text: string) => Promise<void>;
  updateStatus: () => void;
}

export class ApprovalInputCoordinator {
  private readonly approvals: ApprovalCoordinator;
  private readonly pendingInputs: PendingUserInputCoordinator;

  constructor(host: ApprovalInputHost) {
    this.approvals = new ApprovalCoordinator(host);
    this.pendingInputs = new PendingUserInputCoordinator(host);
  }

  stop(): void {
    this.approvals.stop();
  }

  async recoverPendingApprovals(): Promise<void> {
    await this.approvals.recoverPendingApprovals();
  }

  async recoverPendingUserInputs(): Promise<void> {
    await this.pendingInputs.recoverPendingUserInputs();
  }

  async handleApprovalRequest(
    kind: PendingApprovalRecord['kind'],
    serverRequestId: string | number,
    params: any,
  ): Promise<void> {
    await this.approvals.handleApprovalRequest(kind, serverRequestId, params);
  }

  async handleApprovalCallback(
    event: TelegramCallbackEvent,
    localId: string,
    action: ApprovalAction | 'details' | 'back',
    locale: AppLocale,
  ): Promise<boolean> {
    return this.approvals.handleApprovalCallback(event, localId, action, locale);
  }

  async handlePendingUserInputRequest(serverRequestId: string | number, params: any): Promise<void> {
    await this.pendingInputs.handlePendingUserInputRequest(serverRequestId, params);
  }

  async handlePendingUserInputText(scopeId: string, text: string, locale: AppLocale): Promise<boolean> {
    return this.pendingInputs.handlePendingUserInputText(scopeId, text, locale);
  }

  async handlePendingUserInputCallback(
    event: TelegramCallbackEvent,
    localId: string,
    action: string,
    locale: AppLocale,
  ): Promise<boolean> {
    return this.pendingInputs.handlePendingUserInputCallback(event, localId, action, locale);
  }

  async clearPendingUserInputsIfNeeded(scopeId: string, locale: AppLocale): Promise<void> {
    await this.pendingInputs.clearPendingUserInputsIfNeeded(scopeId, locale);
  }
}
