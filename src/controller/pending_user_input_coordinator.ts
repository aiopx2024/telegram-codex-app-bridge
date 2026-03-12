import crypto from 'node:crypto';
import { t } from '../i18n.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import type { CodexAppClient } from '../codex_app/client.js';
import type {
  AppLocale,
  PendingUserInputQuestion,
  PendingUserInputRecord,
} from '../types.js';
import type { TelegramCallbackEvent } from '../telegram/gateway.js';
import {
  buildPendingUserInputResponse,
  isPendingUserInputReview,
  isTelegramMessageGone,
  renderAnsweredPendingUserInputMessage,
  renderCancelledPendingUserInputMessage,
  renderPendingUserInputStage,
  renderResolvedPendingUserInputMessage,
  type InlineKeyboard,
} from './approval_rendering.js';

interface PendingUserInputHost {
  store: BridgeStore;
  logger: Logger;
  app: Pick<CodexAppClient, 'respond' | 'respondError'>;
  resolveChatByThread: (threadId: string) => string | null;
  localeForChat: (scopeId: string) => AppLocale;
  shouldAllowInteractiveUserInput: (scopeId: string) => boolean;
  notePendingUserInputStatus: (threadId: string, localId: string) => Promise<void>;
  clearPendingUserInputStatus: (threadId: string, localId: string) => Promise<void>;
  sendMessage: (scopeId: string, text: string, inlineKeyboard?: InlineKeyboard) => Promise<number>;
  sendHtmlMessage: (scopeId: string, text: string, inlineKeyboard?: InlineKeyboard) => Promise<number>;
  editHtmlMessage: (scopeId: string, messageId: number, text: string, inlineKeyboard?: InlineKeyboard) => Promise<void>;
  answerCallback: (callbackQueryId: string, text: string) => Promise<void>;
  updateStatus: () => void;
}

export class PendingUserInputCoordinator {
  constructor(private readonly host: PendingUserInputHost) {}

  async recoverPendingUserInputs(): Promise<void> {
    for (const pendingInput of this.host.store.listPendingUserInputs()) {
      const locale = this.host.localeForChat(pendingInput.chatId);
      const messageId = await this.openPendingUserInputPrompt(pendingInput, locale);
      this.host.store.updatePendingUserInputMessage(pendingInput.localId, messageId);
    }
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
