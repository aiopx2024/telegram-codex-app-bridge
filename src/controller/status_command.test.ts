import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../config.js';
import { Logger } from '../logger.js';
import { BridgeStore } from '../store/database.js';
import { BridgeController } from './controller.js';
import type { TelegramTextEvent } from '../telegram/gateway.js';

function withController(run: (
  controller: BridgeController,
  store: BridgeStore,
  bot: ReturnType<typeof makeBot>,
) => Promise<void>): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-status-'));
  const store = new BridgeStore(path.join(tempDir, 'bridge.sqlite'));
  const bot = makeBot();
  const controller = new BridgeController(
    makeConfig(tempDir),
    store,
    new Logger('error', path.join(tempDir, 'bridge.log')),
    bot as any,
    makeApp() as any,
  );
  return Promise.resolve(run(controller, store, bot)).finally(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
}

function makeConfig(tempDir: string): AppConfig {
  return {
    tgBotToken: 'token',
    tgAllowedUserId: 'user-1',
    tgAllowedChatId: null,
    tgAllowedTopicId: null,
    codexCliBin: 'codex',
    codexAppAutolaunch: false,
    codexAppLaunchCmd: '',
    codexAppSyncOnOpen: false,
    codexAppSyncOnTurnComplete: false,
    storePath: path.join(tempDir, 'bridge.sqlite'),
    logLevel: 'error',
    defaultCwd: tempDir,
    defaultApprovalPolicy: 'on-request',
    defaultSandboxMode: 'workspace-write',
    telegramPollIntervalMs: 1000,
    telegramPreviewThrottleMs: 50,
    threadListLimit: 10,
    statusPath: path.join(tempDir, 'status.json'),
    logPath: path.join(tempDir, 'bridge.log'),
    lockPath: path.join(tempDir, 'bridge.lock'),
  };
}

function makeBot() {
  return {
    messages: [] as Array<{ chatId: string; text: string }>,
    async sendMessage(chatId: string, text: string) {
      this.messages.push({ chatId, text });
      return 101;
    },
    async sendHtmlMessage() { return 101; },
    async editMessage() {},
    async editHtmlMessage() {},
    async answerCallback() {},
    async clearMessageInlineKeyboard() {},
    async deleteMessage() {},
    async sendTypingInThread() {},
    async sendMessageDraft() {},
    async start() {},
    stop() {},
    username: 'bot',
  };
}

function makeApp() {
  return {
    isConnected() {
      return true;
    },
    getUserAgent() {
      return 'test-agent';
    },
    async readAccountRateLimits() {
      return {
        limitId: 'codex',
        limitName: null,
        primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1773082597 },
        secondary: { usedPercent: 81, windowDurationMins: 10080, resetsAt: 1773531564 },
        credits: { hasCredits: false, unlimited: false, balance: '0' },
        planType: 'plus',
      };
    },
    getAccountRateLimits() {
      return null;
    },
  };
}

function makeTextEvent(text: string): TelegramTextEvent {
  return {
    chatId: 'chat-1',
    topicId: null,
    scopeId: 'chat-1',
    chatType: 'private',
    userId: 'user-1',
    text,
    messageId: 1,
    attachments: [],
    entities: [],
    replyToBot: false,
    languageCode: 'zh',
  };
}

test('/status shows 5-hour and weekly rate limit usage', async () => {
  await withController(async (controller, store, bot) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'zh');

    await (controller as any).handleCommand(makeTextEvent('/status'), 'zh', 'status', []);

    const text = bot.messages[0]?.text ?? '';
    assert.match(text, /账户套餐：plus/);
    assert.match(text, /5小时额度：已用 37%/);
    assert.match(text, /本周额度：已用 81%/);
  });
});
