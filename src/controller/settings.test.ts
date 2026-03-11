import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../config.js';
import { Logger } from '../logger.js';
import { BridgeStore } from '../store/database.js';
import type { TelegramCallbackEvent } from '../telegram/gateway.js';
import { createBridgeComposition } from './composition.js';

function withComposition(run: (
  composition: ReturnType<typeof createBridgeComposition>,
  store: BridgeStore,
  bot: ReturnType<typeof makeBot>,
) => Promise<void>): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-settings-'));
  const store = new BridgeStore(path.join(tempDir, 'bridge.sqlite'));
  const bot = makeBot();
  const composition = createBridgeComposition(
    makeConfig(tempDir),
    store,
    new Logger('error', path.join(tempDir, 'bridge.log')),
    bot as any,
    makeApp() as any,
  );
  return Promise.resolve(run(composition, store, bot)).finally(() => {
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
    defaultCwd: '/tmp/demo',
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
    answers: [] as string[],
    edits: [] as Array<{ messageId: number; text: string; keyboard: unknown }>,
    async answerCallback(_id: string, text: string) {
      this.answers.push(text);
    },
    async editHtmlMessage(_chatId: string, messageId: number, text: string, keyboard?: unknown) {
      this.edits.push({ messageId, text, keyboard: keyboard ?? null });
    },
    async sendHtmlMessage() { return 77; },
    async sendMessage() { return 77; },
    async editMessage() {},
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
  };
}

function makeCallback(data: string): TelegramCallbackEvent {
  return {
    chatId: 'chat-1',
    topicId: null,
    scopeId: 'chat-1',
    userId: 'user-1',
    data,
    callbackQueryId: 'cb-1',
    messageId: 77,
    languageCode: 'en',
  };
}

test('settings callback toggles guided-plan preferences and refreshes the settings home panel', async () => {
  await withComposition(async (composition, store, bot) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
    store.setChatGuidedPlanPreferences('chat-1', {
      confirmPlanBeforeExecute: true,
      autoQueueMessages: true,
      persistPlanHistory: true,
    });
    store.setBinding('chat-1', 'thread-1', '/tmp/demo');

    await composition.telegramRouter.handleCallback(makeCallback('settings:queue:off'));

    const settings = store.getChatSettings('chat-1');
    assert.equal(settings?.autoQueueMessages, false);
    assert.match(bot.edits[0]?.text ?? '', /<b>Settings<\/b>/);
    assert.match(bot.answers[0] ?? '', /Auto queue: no/);
  });
});
