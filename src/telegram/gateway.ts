import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { callTelegramApi } from './api.js';
import type { BridgeStore } from '../store/database.js';
import type { Logger } from '../logger.js';
import { getTelegramCommands } from '../i18n.js';

interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  language_code?: string;
}

interface TelegramChat {
  id: number;
  type: string;
  username?: string;
  title?: string;
}

interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface GetMeResult {
  id: number;
  username?: string;
}

interface SendMessageResult {
  message_id: number;
}

export interface TelegramTextEvent {
  chatId: string;
  userId: string;
  text: string;
  messageId: number;
  languageCode?: string;
}

export interface TelegramCallbackEvent {
  chatId: string;
  userId: string;
  data: string;
  callbackQueryId: string;
  messageId: number;
  languageCode?: string;
}

export class TelegramGateway extends EventEmitter {
  private running = false;
  private botKey: string;
  private botUsername: string | null = null;

  constructor(
    private readonly botToken: string,
    private readonly allowedUserId: string,
    private readonly pollIntervalMs: number,
    private readonly store: BridgeStore,
    private readonly logger: Logger,
  ) {
    super();
    this.botKey = `telegram:${crypto.createHash('sha256').update(this.botToken).digest('hex').slice(0, 8)}`;
  }

  get username(): string | null {
    return this.botUsername;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.resolveBotIdentity();
    await this.registerCommands();
    void this.pollLoop();
  }

  stop(): void {
    this.running = false;
  }

  async sendMessage(chatId: string, text: string, inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>): Promise<number> {
    return this.sendMessageWithOptions(chatId, text, inlineKeyboard);
  }

  async sendHtmlMessage(chatId: string, text: string, inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>): Promise<number> {
    return this.sendMessageWithOptions(chatId, text, inlineKeyboard, 'HTML');
  }

  async editMessage(chatId: string, messageId: number, text: string, inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>): Promise<void> {
    return this.editMessageWithOptions(chatId, messageId, text, inlineKeyboard);
  }

  async editHtmlMessage(chatId: string, messageId: number, text: string, inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>): Promise<void> {
    return this.editMessageWithOptions(chatId, messageId, text, inlineKeyboard, 'HTML');
  }

  private async sendMessageWithOptions(
    chatId: string,
    text: string,
    inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
    parseMode?: 'HTML',
  ): Promise<number> {
    const result = await callTelegramApi<SendMessageResult>(this.botToken, 'sendMessage', {
      chat_id: chatId,
      text,
      ...(inlineKeyboard ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {}),
      ...(parseMode ? { parse_mode: parseMode } : {}),
      disable_web_page_preview: true,
    });
    if (!result.ok || !result.result) {
      throw new Error(result.description || 'Failed to send Telegram message');
    }
    return result.result.message_id;
  }

  private async editMessageWithOptions(
    chatId: string,
    messageId: number,
    text: string,
    inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
    parseMode?: 'HTML',
  ): Promise<void> {
    const result = await callTelegramApi(this.botToken, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(inlineKeyboard ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {}),
      ...(parseMode ? { parse_mode: parseMode } : {}),
      disable_web_page_preview: true,
    });
    if (!result.ok && !String(result.description || '').includes('message is not modified')) {
      throw new Error(result.description || 'Failed to edit Telegram message');
    }
  }

  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    const result = await callTelegramApi(this.botToken, 'deleteMessage', {
      chat_id: chatId,
      message_id: messageId,
    });
    if (!result.ok) {
      throw new Error(result.description || 'Failed to delete Telegram message');
    }
  }

  async answerCallback(callbackQueryId: string, text = 'OK'): Promise<void> {
    await callTelegramApi(this.botToken, 'answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
    });
  }

  async sendTyping(chatId: string): Promise<void> {
    await callTelegramApi(this.botToken, 'sendChatAction', {
      chat_id: chatId,
      action: 'typing',
    });
  }

  private async resolveBotIdentity(): Promise<void> {
    const result = await callTelegramApi<GetMeResult>(this.botToken, 'getMe', {});
    if (result.ok && result.result) {
      this.botKey = `telegram:bot${result.result.id}`;
      this.botUsername = result.result.username ?? null;
    }
  }

  private async registerCommands(): Promise<void> {
    await callTelegramApi(this.botToken, 'setMyCommands', {
      commands: getTelegramCommands('en'),
    });
    await callTelegramApi(this.botToken, 'setMyCommands', {
      commands: getTelegramCommands('zh'),
      language_code: 'zh',
    });
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const offset = this.store.getTelegramOffset(this.botKey) + 1;
        const result = await callTelegramApi<TelegramUpdate[]>(this.botToken, 'getUpdates', {
          timeout: Math.max(1, Math.floor(this.pollIntervalMs / 1000)),
          offset,
          allowed_updates: ['message', 'callback_query']
        });
        if (!result.ok || !result.result) {
          this.logger.warn('telegram.getUpdates failed', result.description);
          await sleep(this.pollIntervalMs);
          continue;
        }
        for (const update of result.result) {
          this.store.setTelegramOffset(this.botKey, update.update_id);
          await this.handleUpdate(update);
        }
      } catch (error) {
        this.logger.error('telegram.pollLoop error', toErrorMeta(error));
        await sleep(this.pollIntervalMs);
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message?.text && update.message.from && update.message.chat.type === 'private') {
      if (String(update.message.from.id) !== this.allowedUserId) return;
      this.emit('text', {
        chatId: String(update.message.chat.id),
        userId: String(update.message.from.id),
        text: update.message.text,
        messageId: update.message.message_id,
        ...(update.message.from.language_code ? { languageCode: update.message.from.language_code } : {}),
      } satisfies TelegramTextEvent);
      return;
    }

    if (update.callback_query?.data && update.callback_query.from && update.callback_query.message) {
      if (String(update.callback_query.from.id) !== this.allowedUserId) return;
      this.emit('callback', {
        chatId: String(update.callback_query.message.chat.id),
        userId: String(update.callback_query.from.id),
        data: update.callback_query.data,
        callbackQueryId: update.callback_query.id,
        messageId: update.callback_query.message.message_id,
        ...(update.callback_query.from.language_code ? { languageCode: update.callback_query.from.language_code } : {}),
      } satisfies TelegramCallbackEvent);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toErrorMeta(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { error: String(error) };
}
