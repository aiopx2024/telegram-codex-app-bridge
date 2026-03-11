import crypto from 'node:crypto';
import { t } from '../i18n.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import type { CodexAppClient } from '../codex_app/client.js';
import type {
  AppLocale,
  PendingApprovalRecord,
  PendingUserInputQuestion,
  PendingUserInputRecord,
} from '../types.js';
import type { TelegramCallbackEvent } from '../telegram/gateway.js';

export type ApprovalAction = 'accept' | 'session' | 'deny';

type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

interface ApprovalInputHost {
  store: BridgeStore;
  logger: Logger;
  app: Pick<CodexAppClient, 'respond' | 'respondError'>;
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
  private approvalTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly host: ApprovalInputHost) {}

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
        approvalKeyboard(locale, approval.localId),
      );
      this.host.store.updatePendingApprovalMessage(approval.localId, messageId);
      this.armApprovalTimer(approval.localId);
    }
  }

  async recoverPendingUserInputs(): Promise<void> {
    for (const pendingInput of this.host.store.listPendingUserInputs()) {
      const locale = this.host.localeForChat(pendingInput.chatId);
      const messageId = await this.openPendingUserInputPrompt(pendingInput, locale);
      this.host.store.updatePendingUserInputMessage(pendingInput.localId, messageId);
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
      approvalKeyboard(locale, approval.localId),
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
          approvalKeyboard(locale, approval.localId, action === 'details'),
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

  async handlePendingUserInputRequest(serverRequestId: string | number, params: any): Promise<void> {
    const pendingInput = this.createPendingUserInputRecord(serverRequestId, params);
    await this.host.notePendingUserInputStatus(pendingInput.threadId, pendingInput.localId);
    const locale = this.host.localeForChat(pendingInput.chatId);
    const messageId = await this.openPendingUserInputPrompt(pendingInput, locale);
    this.host.store.updatePendingUserInputMessage(pendingInput.localId, messageId);
    this.host.updateStatus();
  }

  async handlePendingUserInputText(scopeId: string, text: string, locale: AppLocale): Promise<boolean> {
    const record = this.host.store.getPendingUserInputForChat(scopeId);
    if (!record) {
      return false;
    }
    if (!this.host.shouldAllowInteractiveUserInput(scopeId)) {
      await this.cancelPendingUserInput(record, locale);
      return true;
    }
    if (isPendingUserInputReview(record)) {
      await this.host.sendMessage(scopeId, t(locale, 'input_review_buttons_only'));
      return true;
    }
    const currentQuestion = record.questions[record.currentQuestionIndex] ?? null;
    if (currentQuestion?.options?.length && !record.awaitingFreeText) {
      await this.host.sendMessage(
        scopeId,
        currentQuestion.isOther ? t(locale, 'input_use_buttons_or_other') : t(locale, 'input_use_buttons_only'),
      );
      return true;
    }
    const answer = text.trim();
    if (!answer) {
      await this.host.sendMessage(scopeId, t(locale, 'input_reply_only'));
      return true;
    }
    await this.applyPendingUserInputAnswer(record, [answer], locale);
    return true;
  }

  async handlePendingUserInputCallback(
    event: TelegramCallbackEvent,
    localId: string,
    action: string,
    locale: AppLocale,
  ): Promise<boolean> {
    const record = this.host.store.getPendingUserInput(localId);
    if (!record || record.resolvedAt !== null) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'input_already_resolved'));
      return true;
    }
    if (record.chatId !== event.scopeId || (record.messageId !== null && record.messageId !== event.messageId)) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'input_mismatch'));
      return true;
    }
    const question = record.questions[record.currentQuestionIndex] ?? null;
    if (!question && !isPendingUserInputReview(record)) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'input_already_resolved'));
      return true;
    }
    if (action === 'cancel') {
      await this.cancelPendingUserInput(record, locale);
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'input_cancelled'));
      return true;
    }
    if (isPendingUserInputReview(record)) {
      if (action === 'submit') {
        await this.finalizePendingUserInput(record, record.answers, locale);
        await this.host.answerCallback(event.callbackQueryId, t(locale, 'input_submit_recorded'));
        return true;
      }
      const editMatch = /^edit:(\d+)$/.exec(action);
      if (editMatch) {
        const targetIndex = Number.parseInt(editMatch[1] || '', 10);
        if (Number.isNaN(targetIndex)) {
          await this.host.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
          return true;
        }
        await this.rewindPendingUserInput(record, targetIndex, locale);
        await this.host.answerCallback(event.callbackQueryId, t(locale, 'input_edit_answer_requested'));
        return true;
      }
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
      return true;
    }
    if (!question) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'input_already_resolved'));
      return true;
    }
    if (action === 'back') {
      if (record.currentQuestionIndex === 0) {
        await this.host.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
        return true;
      }
      await this.rewindPendingUserInput(record, record.currentQuestionIndex - 1, locale);
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'input_back_requested'));
      return true;
    }
    if (action === 'other') {
      this.host.store.updatePendingUserInputState(record.localId, record.answers, record.currentQuestionIndex, true);
      const updated = this.host.store.getPendingUserInput(record.localId);
      if (updated) {
        await this.refreshPendingUserInputPrompt(updated, locale);
      }
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'input_custom_answer_requested'));
      return true;
    }
    const match = /^option:(\d+)$/.exec(action);
    if (!match || !question.options) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
      return true;
    }
    const optionIndex = Number.parseInt(match[1] || '', 10);
    const option = question.options[optionIndex];
    if (!option) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
      return true;
    }
    await this.applyPendingUserInputAnswer(record, [option.label], locale);
    await this.host.answerCallback(event.callbackQueryId, t(locale, 'input_answer_recorded'));
    return true;
  }

  async clearPendingUserInputsIfNeeded(scopeId: string, locale: AppLocale): Promise<void> {
    for (const record of this.host.store.listPendingUserInputs(scopeId)) {
      await this.cancelPendingUserInput(record, locale);
    }
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

  private createPendingUserInputRecord(serverRequestId: string | number, params: any): PendingUserInputRecord {
    const threadId = String(params.threadId);
    const scopeId = this.host.resolveChatByThread(threadId);
    if (!scopeId) {
      throw new Error(`No chat binding found for thread ${threadId}`);
    }
    const questions = Array.isArray(params.questions)
      ? params.questions.map((question: any): PendingUserInputQuestion => {
          const options = Array.isArray(question.options)
            ? question.options
              .map((option: any) => ({
                label: String(option.label || ''),
                description: String(option.description || ''),
              }))
              .filter((option: { label: string }) => option.label.trim())
            : [];
          return {
            id: String(question.id),
            header: String(question.header || question.id || 'Question'),
            question: String(question.question || ''),
            isOther: Boolean(question.isOther),
            isSecret: Boolean(question.isSecret),
            options: options.length > 0 ? options : null,
          };
        })
      : [];
    const record: PendingUserInputRecord = {
      localId: crypto.randomBytes(8).toString('hex'),
      serverRequestId: String(serverRequestId),
      chatId: scopeId,
      threadId,
      turnId: String(params.turnId),
      itemId: String(params.itemId),
      messageId: null,
      questions,
      answers: {},
      currentQuestionIndex: 0,
      awaitingFreeText: false,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    this.host.store.savePendingUserInput(record);
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

  private async openPendingUserInputPrompt(record: PendingUserInputRecord, locale: AppLocale): Promise<number> {
    const rendered = renderPendingUserInputStage(locale, record);
    const messageId = await this.host.sendHtmlMessage(record.chatId, rendered.html, rendered.keyboard);
    this.host.store.savePendingUserInputMessage({
      inputLocalId: record.localId,
      questionIndex: rendered.questionIndex,
      messageId,
      messageKind: rendered.messageKind,
      createdAt: Date.now(),
    });
    return messageId;
  }

  private async refreshPendingUserInputPrompt(record: PendingUserInputRecord, locale: AppLocale): Promise<void> {
    const rendered = renderPendingUserInputStage(locale, record);
    if (record.messageId !== null) {
      try {
        await this.host.editHtmlMessage(record.chatId, record.messageId, rendered.html, rendered.keyboard);
        this.host.store.savePendingUserInputMessage({
          inputLocalId: record.localId,
          questionIndex: rendered.questionIndex,
          messageId: record.messageId,
          messageKind: rendered.messageKind,
          createdAt: Date.now(),
        });
        return;
      } catch (error) {
        if (!isTelegramMessageGone(error)) {
          throw error;
        }
      }
    }
    const messageId = await this.host.sendHtmlMessage(record.chatId, rendered.html, rendered.keyboard);
    this.host.store.savePendingUserInputMessage({
      inputLocalId: record.localId,
      questionIndex: rendered.questionIndex,
      messageId,
      messageKind: rendered.messageKind,
      createdAt: Date.now(),
    });
    this.host.store.updatePendingUserInputMessage(record.localId, messageId);
  }

  private async finalizePendingUserInput(
    record: PendingUserInputRecord,
    answers: Record<string, string[]>,
    locale: AppLocale,
  ): Promise<void> {
    await this.host.app.respond(record.serverRequestId, { answers: buildPendingUserInputResponse(answers) });
    this.host.store.markPendingUserInputResolved(record.localId);
    await this.host.clearPendingUserInputStatus(record.threadId, record.localId);
    if (record.messageId !== null) {
      try {
        await this.host.editHtmlMessage(record.chatId, record.messageId, renderResolvedPendingUserInputMessage(locale, record, answers), []);
      } catch (error) {
        if (!isTelegramMessageGone(error)) {
          this.host.logger.warn('telegram.pending_input_resolved_edit_failed', {
            localId: record.localId,
            error: String(error),
          });
        }
      }
    }
    this.host.updateStatus();
  }

  private async cancelPendingUserInput(record: PendingUserInputRecord, locale: AppLocale): Promise<void> {
    await this.host.app.respondError(record.serverRequestId, 'User cancelled the requested input');
    this.host.store.markPendingUserInputResolved(record.localId);
    await this.host.clearPendingUserInputStatus(record.threadId, record.localId);
    if (record.messageId !== null) {
      try {
        await this.host.editHtmlMessage(record.chatId, record.messageId, renderCancelledPendingUserInputMessage(locale, record), []);
      } catch (error) {
        if (!isTelegramMessageGone(error)) {
          this.host.logger.warn('telegram.pending_input_cancel_edit_failed', {
            localId: record.localId,
            error: String(error),
          });
        }
      }
    }
    this.host.updateStatus();
  }

  private async rewindPendingUserInput(
    record: PendingUserInputRecord,
    targetQuestionIndex: number,
    locale: AppLocale,
  ): Promise<void> {
    const nextIndex = Math.max(0, Math.min(targetQuestionIndex, Math.max(0, record.questions.length - 1)));
    const retainedAnswers = Object.fromEntries(
      record.questions
        .slice(0, nextIndex)
        .map((question) => [question.id, record.answers[question.id]])
        .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].length > 0),
    );
    this.host.store.updatePendingUserInputState(record.localId, retainedAnswers, nextIndex, false);
    const updated = this.host.store.getPendingUserInput(record.localId);
    if (!updated) {
      return;
    }
    await this.refreshPendingUserInputPrompt(updated, locale);
    this.host.updateStatus();
  }

  private async applyPendingUserInputAnswer(
    record: PendingUserInputRecord,
    answer: string[],
    locale: AppLocale,
  ): Promise<void> {
    const currentQuestion = record.questions[record.currentQuestionIndex] ?? null;
    if (!currentQuestion) {
      return;
    }
    await this.lockPendingUserInputPrompt(record, currentQuestion, answer, locale);
    const answers = {
      ...record.answers,
      [currentQuestion.id]: answer,
    };
    const nextQuestionIndex = record.currentQuestionIndex + 1;
    this.host.store.updatePendingUserInputState(record.localId, answers, nextQuestionIndex, false);
    const updated = this.host.store.getPendingUserInput(record.localId);
    if (!updated) {
      return;
    }
    if (nextQuestionIndex < updated.questions.length) {
      const messageId = await this.openPendingUserInputPrompt(updated, locale);
      this.host.store.updatePendingUserInputMessage(updated.localId, messageId);
      this.host.updateStatus();
      return;
    }
    await this.refreshPendingUserInputPrompt(updated, locale);
  }

  private async lockPendingUserInputPrompt(
    record: PendingUserInputRecord,
    question: PendingUserInputQuestion,
    answer: string[],
    locale: AppLocale,
  ): Promise<void> {
    if (record.messageId === null) {
      return;
    }
    try {
      await this.host.editHtmlMessage(
        record.chatId,
        record.messageId,
        renderAnsweredPendingUserInputMessage(locale, record, question, answer),
        [],
      );
    } catch (error) {
      if (!isTelegramMessageGone(error)) {
        throw error;
      }
    }
  }
}

function approvalKeyboard(
  locale: AppLocale,
  localId: string,
  detailsOpen = false,
): InlineKeyboard {
  return [
    [
      { text: t(locale, 'button_allow'), callback_data: `approval:${localId}:accept` },
      { text: t(locale, 'button_allow_session'), callback_data: `approval:${localId}:session` },
      { text: t(locale, 'button_deny'), callback_data: `approval:${localId}:deny` },
    ],
    [{
      text: t(locale, detailsOpen ? 'button_back' : 'button_details'),
      callback_data: `approval:${localId}:${detailsOpen ? 'back' : 'details'}`,
    }],
  ];
}

function buildPendingInputNavigationRow(
  locale: AppLocale,
  localId: string,
  currentQuestionIndex: number,
): Array<{ text: string; callback_data: string }> {
  const row = [{ text: t(locale, 'button_cancel'), callback_data: `input:${localId}:cancel` }];
  if (currentQuestionIndex > 0) {
    row.unshift({ text: t(locale, 'button_back'), callback_data: `input:${localId}:back` });
  }
  return row;
}

function buildPendingUserInputReviewKeyboard(
  locale: AppLocale,
  record: PendingUserInputRecord,
): InlineKeyboard {
  const rows: InlineKeyboard = [[
    { text: t(locale, 'button_submit'), callback_data: `input:${record.localId}:submit` },
    { text: t(locale, 'button_cancel'), callback_data: `input:${record.localId}:cancel` },
  ]];
  for (let index = 0; index < record.questions.length; index += 1) {
    const question = record.questions[index]!;
    rows.push([{
      text: truncateInline(`${t(locale, 'input_review_edit')}: ${question.header}`, 32),
      callback_data: `input:${record.localId}:edit:${index}`,
    }]);
  }
  return rows;
}

function renderPendingUserInputStage(
  locale: AppLocale,
  record: PendingUserInputRecord,
): {
  html: string;
  keyboard: InlineKeyboard;
  messageKind: 'question' | 'review';
  questionIndex: number;
} {
  if (isPendingUserInputReview(record)) {
    return {
      ...renderPendingUserInputReviewMessage(locale, record),
      messageKind: 'review',
      questionIndex: Math.max(0, record.questions.length - 1),
    };
  }
  const currentQuestion = record.questions[record.currentQuestionIndex] ?? null;
  return {
    ...renderPendingUserInputMessage(locale, record, currentQuestion),
    messageKind: 'question',
    questionIndex: record.currentQuestionIndex,
  };
}

export function renderPendingUserInputMessage(
  locale: AppLocale,
  record: PendingUserInputRecord,
  question: PendingUserInputQuestion | null,
): { html: string; keyboard: InlineKeyboard } {
  const progress = `${record.currentQuestionIndex + 1}/${Math.max(record.questions.length, 1)}`;
  const lines = [
    t(locale, 'input_requested'),
    t(locale, 'line_thread', { value: escapeTelegramHtml(record.threadId) }),
    t(locale, 'line_turn', { value: escapeTelegramHtml(record.turnId) }),
    `<b>${escapeTelegramHtml(question?.header || 'Question')} (${progress})</b>`,
    escapeTelegramHtml(question?.question || ''),
  ];
  const optionLines = (question?.options ?? [])
    .filter(option => option.label.trim())
    .map((option, index) => {
      const recommendedPrefix = index === 0 ? `${escapeTelegramHtml(t(locale, 'input_recommended'))}: ` : '';
      return `${index + 1}. ${recommendedPrefix}${escapeTelegramHtml(option.label)}${option.description ? ` - ${escapeTelegramHtml(option.description)}` : ''}`;
    });
  if (optionLines.length > 0) {
    lines.push(`<blockquote expandable>${optionLines.join('\n')}</blockquote>`);
  }
  if (record.awaitingFreeText) {
    lines.push(t(locale, 'input_reply_only'));
  } else if (optionLines.length > 0) {
    lines.push(question?.isOther ? t(locale, 'input_select_or_other') : t(locale, 'input_select_only'));
  } else {
    lines.push(t(locale, 'input_reply_only'));
  }
  lines.push(record.currentQuestionIndex > 0 ? t(locale, 'input_question_actions_back_cancel') : t(locale, 'input_question_actions_cancel'));
  return {
    html: lines.filter(Boolean).join('\n'),
    keyboard: buildPendingUserInputKeyboard(locale, record, question, record.awaitingFreeText),
  };
}

function buildPendingUserInputKeyboard(
  locale: AppLocale,
  record: PendingUserInputRecord,
  question: PendingUserInputQuestion | null,
  awaitingFreeText: boolean,
): InlineKeyboard {
  const rows: InlineKeyboard = [];
  if (question && !awaitingFreeText && question.options && question.options.length > 0) {
    rows.push(...question.options.map((option, index) => [{
      text: truncateInline(
        index === 0
          ? `${t(locale, 'button_recommended')}: ${option.label}`
          : option.label,
        32,
      ),
      callback_data: `input:${record.localId}:option:${index}`,
    }]));
  }
  if (question?.isOther) {
    rows.push([{ text: t(locale, 'button_other'), callback_data: `input:${record.localId}:other` }]);
  }
  rows.push(buildPendingInputNavigationRow(locale, record.localId, record.currentQuestionIndex));
  return rows;
}

export function renderPendingUserInputReviewMessage(
  locale: AppLocale,
  record: PendingUserInputRecord,
): { html: string; keyboard: InlineKeyboard } {
  const lines = [
    `<b>${escapeTelegramHtml(t(locale, 'input_review_title'))}</b>`,
    t(locale, 'line_thread', { value: escapeTelegramHtml(record.threadId) }),
    t(locale, 'line_turn', { value: escapeTelegramHtml(record.turnId) }),
    t(locale, 'input_review_prompt'),
  ];
  for (let index = 0; index < record.questions.length; index += 1) {
    const question = record.questions[index]!;
    const answer = record.answers[question.id] ?? [];
    lines.push(`<b>${index + 1}. ${escapeTelegramHtml(question.header)}</b>`);
    lines.push(t(locale, 'line_answer', { value: escapeTelegramHtml(answer.join(', ') || t(locale, 'empty')) }));
  }
  return {
    html: lines.join('\n'),
    keyboard: buildPendingUserInputReviewKeyboard(locale, record),
  };
}

export function renderAnsweredPendingUserInputMessage(
  locale: AppLocale,
  record: PendingUserInputRecord,
  question: PendingUserInputQuestion,
  answer: string[],
): string {
  const progress = `${record.currentQuestionIndex + 1}/${Math.max(record.questions.length, 1)}`;
  return [
    `<b>${escapeTelegramHtml(t(locale, 'input_answer_recorded'))}</b>`,
    t(locale, 'line_thread', { value: escapeTelegramHtml(record.threadId) }),
    t(locale, 'line_turn', { value: escapeTelegramHtml(record.turnId) }),
    `<b>${escapeTelegramHtml(question.header)} (${progress})</b>`,
    escapeTelegramHtml(question.question),
    t(locale, 'line_answer', { value: escapeTelegramHtml(answer.join(', ')) }),
  ].filter(Boolean).join('\n');
}

export function renderResolvedPendingUserInputMessage(
  locale: AppLocale,
  record: PendingUserInputRecord,
  answers: Record<string, string[]>,
): string {
  const lines = [
    `<b>${escapeTelegramHtml(t(locale, 'input_answer_recorded'))}</b>`,
    t(locale, 'line_thread', { value: escapeTelegramHtml(record.threadId) }),
    t(locale, 'line_turn', { value: escapeTelegramHtml(record.turnId) }),
  ];
  for (const question of record.questions) {
    const answer = answers[question.id];
    if (!answer || answer.length === 0) {
      continue;
    }
    lines.push(`<b>${escapeTelegramHtml(question.header)}</b>`);
    lines.push(t(locale, 'line_answer', { value: escapeTelegramHtml(answer.join(', ')) }));
  }
  return lines.join('\n');
}

export function renderCancelledPendingUserInputMessage(
  locale: AppLocale,
  record: PendingUserInputRecord,
): string {
  return [
    `<b>${escapeTelegramHtml(t(locale, 'input_cancelled'))}</b>`,
    t(locale, 'line_thread', { value: escapeTelegramHtml(record.threadId) }),
    t(locale, 'line_turn', { value: escapeTelegramHtml(record.turnId) }),
  ].join('\n');
}

export function buildPendingUserInputResponse(answers: Record<string, string[]>): Record<string, { answers: string[] }> {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => [questionId, { answers: value }]),
  );
}

export function renderApprovalMessage(locale: AppLocale, record: PendingApprovalRecord, decision?: ApprovalAction): string {
  const lines = [
    t(locale, 'approval_requested', {
      kind: record.kind === 'fileChange' ? t(locale, 'approval_kind_fileChange') : t(locale, 'approval_kind_command'),
    }),
    t(locale, 'line_thread', { value: record.threadId }),
    t(locale, 'line_turn', { value: record.turnId }),
  ];
  if (record.riskLevel) lines.push(t(locale, 'line_risk', { value: t(locale, `approval_risk_${record.riskLevel}`) }));
  if (record.summary) lines.push(t(locale, 'line_summary', { value: record.summary }));
  if (record.command) lines.push(t(locale, 'line_command', { value: truncateInline(record.command, 120) }));
  if (record.cwd) lines.push(t(locale, 'line_cwd', { value: record.cwd }));
  if (record.reason) lines.push(t(locale, 'line_reason', { value: record.reason }));
  if (decision) {
    const decisionKey = decision === 'accept'
      ? 'approval_decision_accept'
      : decision === 'session'
        ? 'approval_decision_session'
        : 'approval_decision_deny';
    lines.push(t(locale, 'line_decision', { value: t(locale, decisionKey) }));
  }
  return lines.join('\n');
}

export function renderApprovalDetailsMessage(locale: AppLocale, record: PendingApprovalRecord): string {
  const lines = [
    t(locale, 'approval_details_title'),
    t(locale, 'approval_requested', {
      kind: record.kind === 'fileChange' ? t(locale, 'approval_kind_fileChange') : t(locale, 'approval_kind_command'),
    }),
    t(locale, 'line_thread', { value: record.threadId }),
    t(locale, 'line_turn', { value: record.turnId }),
  ];
  if (record.riskLevel) lines.push(t(locale, 'line_risk', { value: t(locale, `approval_risk_${record.riskLevel}`) }));
  if (record.summary) lines.push(t(locale, 'line_summary', { value: record.summary }));
  if (record.command) lines.push(t(locale, 'line_command', { value: record.command }));
  if (record.cwd) lines.push(t(locale, 'line_cwd', { value: record.cwd }));
  if (record.reason) lines.push(t(locale, 'line_reason', { value: record.reason }));
  const paths = Array.isArray(record.details?.paths)
    ? record.details.paths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  if (paths.length > 0) {
    lines.push(t(locale, 'line_paths', { value: truncateInline(paths.join(', '), 160) }));
  }
  const counts = formatApprovalChangeCounts(locale, record.details?.counts);
  if (counts) {
    lines.push(t(locale, 'approval_detail_counts', { value: counts }));
  }
  return lines.join('\n');
}

function deriveApprovalDetails(
  kind: PendingApprovalRecord['kind'],
  params: any,
): Pick<PendingApprovalRecord, 'summary' | 'riskLevel' | 'details'> {
  if (kind === 'command') {
    const commandText = typeof params?.command === 'string'
      ? params.command
      : Array.isArray(params?.command)
        ? params.command.map((part: unknown) => String(part)).join(' ')
        : null;
    return {
      summary: commandText ? truncateInline(commandText, 120) : 'Run a command in the workspace',
      riskLevel: inferCommandApprovalRisk(commandText),
      details: {
        command: commandText,
        cwd: typeof params?.cwd === 'string' ? params.cwd : null,
        parsedCmd: Array.isArray(params?.parsedCmd) ? params.parsedCmd : [],
      },
    };
  }

  const changes = normalizeFileChangeApprovalDetails(params);
  return {
    summary: changes.summary,
    riskLevel: inferFileChangeApprovalRisk(changes.paths, changes.counts),
    details: {
      paths: changes.paths,
      counts: changes.counts,
    },
  };
}

function normalizeFileChangeApprovalDetails(params: any): {
  paths: string[];
  counts: { create: number; update: number; delete: number };
  summary: string;
} {
  const rawChanges = Array.isArray(params?.changes)
    ? params.changes
    : Array.isArray(params?.edits)
      ? params.edits
      : [];
  const normalized = (rawChanges as any[])
    .map((entry: any) => ({
      path: extractApprovalPath(entry),
      kind: typeof entry?.kind === 'string'
        ? entry.kind
        : typeof entry?.type === 'string'
          ? entry.type
          : typeof entry?.changeType === 'string'
            ? entry.changeType
            : 'update',
    }))
    .filter((entry: { path: string | null }) => Boolean(entry.path));
  const paths = normalized
    .map((entry: { path: string | null }) => entry.path!)
    .filter((path: string, index: number, values: string[]) => values.indexOf(path) === index);
  const counts = {
    create: normalized.filter((entry: { kind: string }) => /^(create|add|new)$/i.test(entry.kind)).length,
    update: normalized.filter((entry: { kind: string }) => !/^(create|add|new|delete|remove)$/i.test(entry.kind)).length,
    delete: normalized.filter((entry: { kind: string }) => /^(delete|remove)$/i.test(entry.kind)).length,
  };
  const summary = paths.length > 0
    ? truncateInline(`${paths.length} file(s): ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ', ...' : ''}`, 120)
    : 'Review proposed file changes';
  return { paths, counts, summary };
}

function extractApprovalPath(entry: any): string | null {
  const candidates = [entry?.path, entry?.filePath, entry?.target, entry?.newPath, entry?.oldPath];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function inferCommandApprovalRisk(commandText: string | null): PendingApprovalRecord['riskLevel'] {
  const normalized = (commandText ?? '').toLowerCase();
  if (!normalized) {
    return 'medium';
  }
  if (/(^|\s)(sudo|rm\s+-rf|git\s+reset\s+--hard|mkfs|dd\s+if=|shutdown|reboot)(\s|$)/.test(normalized)) {
    return 'high';
  }
  if (/(^|\s)(curl|wget|npm\s+(install|update)|pnpm\s+(install|update)|yarn\s+(add|install)|chmod|chown|docker|kubectl|terraform)(\s|$)/.test(normalized)) {
    return 'medium';
  }
  return 'low';
}

function inferFileChangeApprovalRisk(
  paths: string[],
  counts: { create: number; update: number; delete: number },
): PendingApprovalRecord['riskLevel'] {
  if (counts.delete > 0 || paths.some((path) => /(^|\/)(\.env|\.git|Dockerfile|docker-compose|package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(path))) {
    return 'high';
  }
  if (paths.length > 3 || counts.create > 0) {
    return 'medium';
  }
  return 'low';
}

function formatApprovalChangeCounts(locale: AppLocale, raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const counts = raw as { create?: unknown; update?: unknown; delete?: unknown };
  const parts: string[] = [];
  if (Number(counts.create || 0) > 0) {
    parts.push(locale === 'zh' ? `新增 ${Number(counts.create)} 个` : `${Number(counts.create)} create`);
  }
  if (Number(counts.update || 0) > 0) {
    parts.push(locale === 'zh' ? `修改 ${Number(counts.update)} 个` : `${Number(counts.update)} update`);
  }
  if (Number(counts.delete || 0) > 0) {
    parts.push(locale === 'zh' ? `删除 ${Number(counts.delete)} 个` : `${Number(counts.delete)} delete`);
  }
  return parts.length > 0 ? parts.join(locale === 'zh' ? '，' : ', ') : null;
}

function mapApprovalDecision(action: ApprovalAction): unknown {
  const decision = action === 'accept'
    ? 'accept'
    : action === 'session'
      ? 'acceptForSession'
      : 'decline';
  return { decision };
}

function isPendingUserInputReview(record: PendingUserInputRecord): boolean {
  return record.currentQuestionIndex >= record.questions.length;
}

function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function truncateInline(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function formatUserError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isTelegramMessageGone(error: unknown): boolean {
  const message = formatUserError(error).toLowerCase();
  return message.includes('message to delete not found')
    || message.includes('message to edit not found')
    || message.includes('message not found');
}
