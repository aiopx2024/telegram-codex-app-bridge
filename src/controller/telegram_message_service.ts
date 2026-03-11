import type { TelegramGateway } from '../telegram/gateway.js';
import { parseTelegramScopeId } from '../telegram/scope.js';
import { formatUserError } from './utils.js';

export type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

interface MessageBot {
  sendMessage: TelegramGateway['sendMessage'];
  sendHtmlMessage: TelegramGateway['sendHtmlMessage'];
  editMessage: TelegramGateway['editMessage'];
  editHtmlMessage: TelegramGateway['editHtmlMessage'];
  deleteMessage: TelegramGateway['deleteMessage'];
  sendTypingInThread: TelegramGateway['sendTypingInThread'];
  sendMessageDraft: TelegramGateway['sendMessageDraft'];
  clearMessageInlineKeyboard: TelegramGateway['clearMessageInlineKeyboard'];
}

export class TelegramMessageService {
  constructor(private readonly bot: MessageBot) {}

  async sendMessage(scopeId: string, text: string, inlineKeyboard?: InlineKeyboard): Promise<number> {
    const target = parseTelegramScopeId(scopeId);
    return this.bot.sendMessage(target.chatId, text, inlineKeyboard, target.topicId);
  }

  async sendHtmlMessage(scopeId: string, text: string, inlineKeyboard?: InlineKeyboard): Promise<number> {
    const target = parseTelegramScopeId(scopeId);
    return this.bot.sendHtmlMessage(target.chatId, text, inlineKeyboard, target.topicId);
  }

  async editMessage(scopeId: string, messageId: number, text: string, inlineKeyboard?: InlineKeyboard): Promise<void> {
    const target = parseTelegramScopeId(scopeId);
    await this.bot.editMessage(target.chatId, messageId, text, inlineKeyboard);
  }

  async editHtmlMessage(scopeId: string, messageId: number, text: string, inlineKeyboard?: InlineKeyboard): Promise<void> {
    const target = parseTelegramScopeId(scopeId);
    await this.bot.editHtmlMessage(target.chatId, messageId, text, inlineKeyboard);
  }

  async deleteMessage(scopeId: string, messageId: number): Promise<void> {
    const target = parseTelegramScopeId(scopeId);
    await this.bot.deleteMessage(target.chatId, messageId);
  }

  async sendTyping(scopeId: string): Promise<void> {
    const target = parseTelegramScopeId(scopeId);
    await this.bot.sendTypingInThread(target.chatId, target.topicId);
  }

  async sendDraft(scopeId: string, draftId: number, text: string): Promise<void> {
    const target = parseTelegramScopeId(scopeId);
    await this.bot.sendMessageDraft(target.chatId, draftId, text, target.topicId);
  }

  async clearMessageButtons(scopeId: string, messageId: number): Promise<void> {
    const target = parseTelegramScopeId(scopeId);
    await this.bot.clearMessageInlineKeyboard(target.chatId, messageId);
  }
}

export function isTelegramMessageGone(error: unknown): boolean {
  const message = formatUserError(error).toLowerCase();
  return message.includes('message to delete not found')
    || message.includes('message to edit not found')
    || message.includes('message not found');
}
