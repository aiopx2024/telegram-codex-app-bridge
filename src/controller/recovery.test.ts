import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../config.js';
import { Logger } from '../logger.js';
import { BridgeStore } from '../store/database.js';
import { BridgeController } from './controller.js';
import type { GuidedPlanSession } from '../types.js';

function withController(run: (
  controller: BridgeController,
  store: BridgeStore,
  bot: ReturnType<typeof makeBot>,
  app: ReturnType<typeof makeApp>,
  tempDir: string,
) => Promise<void>): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-recovery-'));
  const store = new BridgeStore(path.join(tempDir, 'bridge.sqlite'));
  const bot = makeBot();
  const app = makeApp(tempDir);
  const controller = new BridgeController(
    makeConfig(tempDir),
    store,
    new Logger('error', path.join(tempDir, 'bridge.log')),
    bot as any,
    app as any,
  );
  return Promise.resolve(run(controller, store, bot, app, tempDir)).finally(async () => {
    await controller.stop();
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
}

function makeConfig(tempDir: string): AppConfig {
  return {
    envFile: path.join(tempDir, '.env'),
    bridgeEngine: 'codex',
    bridgeInstanceId: null,
    bridgeHome: tempDir,
    tgBotToken: 'token',
    tgAllowedUserId: 'user-1',
    tgAllowedChatId: null,
    tgAllowedTopicId: null,
    codexCliBin: 'codex',
    geminiCliBin: 'gemini',
    geminiDefaultModel: 'gemini-3-pro-preview',
    geminiModelAllowlist: ['gemini-3-pro-preview'],
    geminiIncludeDirectories: [],
    geminiHeadlessTimeoutMs: 300_000,
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
  let nextMessageId = 100;
  return {
    htmlMessages: [] as Array<{ chatId: string; text: string; keyboard: unknown }>,
    messages: [] as Array<{ chatId: string; text: string; keyboard: unknown }>,
    typings: [] as Array<{ chatId: string; topicId: number | null | undefined }>,
    on() {},
    async sendHtmlMessage(chatId: string, text: string, keyboard?: unknown) {
      this.htmlMessages.push({ chatId, text, keyboard: keyboard ?? null });
      nextMessageId += 1;
      return nextMessageId;
    },
    async sendMessage(chatId: string, text: string, keyboard?: unknown) {
      this.messages.push({ chatId, text, keyboard: keyboard ?? null });
      nextMessageId += 1;
      return nextMessageId;
    },
    async editHtmlMessage() {},
    async editMessage() {},
    async clearMessageInlineKeyboard() {},
    async deleteMessage() {},
    async sendTypingInThread(chatId: string, topicId?: number | null) {
      this.typings.push({ chatId, topicId });
    },
    async sendMessageDraft() {},
    async start() {},
    stop() {},
    username: 'bot',
  };
}

function makeApp(tempDir: string) {
  return {
    startTurnCalls: [] as any[],
    on() {},
    async start() {},
    async stop() {},
    isConnected() {
      return true;
    },
    getUserAgent() {
      return 'test-agent';
    },
    async resumeThread({ threadId }: { threadId: string }) {
      return {
        thread: {
          threadId,
          name: 'Recovered thread',
          preview: 'Recovered preview',
          cwd: tempDir,
          modelProvider: 'openai',
          status: 'idle',
          updatedAt: Math.floor(Date.now() / 1000),
        },
        model: 'gpt-5',
        modelProvider: 'openai',
        reasoningEffort: 'medium',
        serviceTier: null,
        cwd: tempDir,
      };
    },
    async startTurn(options: any) {
      this.startTurnCalls.push(options);
      return { id: `turn-${this.startTurnCalls.length}`, status: 'running' };
    },
  };
}

function makePlanSession(): GuidedPlanSession {
  return {
    sessionId: 'aa11bb22',
    chatId: 'chat-1',
    threadId: 'thread-1',
    sourceTurnId: 'turn-plan',
    executionTurnId: null,
    state: 'awaiting_plan_confirmation',
    confirmationRequired: true,
    confirmedPlanVersion: null,
    latestPlanVersion: 2,
    currentPromptId: 'prompt-1',
    currentApprovalId: null,
    queueDepth: 0,
    lastPlanMessageId: null,
    lastPromptMessageId: null,
    lastApprovalMessageId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    resolvedAt: null,
  };
}

test('controller.start restores plan confirmation prompts after restart', async () => {
  await withController(async (controller, store, bot) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
    store.savePlanSession(makePlanSession());

    await controller.start();

    assert.match(bot.htmlMessages[0]?.text ?? '', /Review this plan/);
    assert.equal(store.getPlanSession('aa11bb22')?.lastPromptMessageId !== null, true);
  });
});

test('controller.start automatically resumes queued inputs when nothing blocks them', async () => {
  await withController(async (controller, store, _bot, app, tempDir) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
    store.setChatServiceTier('chat-1', 'fast');
    store.setBinding('chat-1', 'thread-1', tempDir);
    store.saveQueuedTurnInput({
      queueId: 'queue-1',
      scopeId: 'chat-1',
      chatId: 'chat-1',
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Resume me', text_elements: [] }],
      sourceSummary: 'Resume me',
      telegramMessageId: null,
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await controller.start();

    assert.equal(app.startTurnCalls.length, 1);
    assert.equal(app.startTurnCalls[0]?.input?.[0]?.text, 'Resume me');
    assert.equal(app.startTurnCalls[0]?.serviceTier, 'fast');
    assert.equal(store.getQueuedTurnInput('queue-1')?.status, 'processing');
  });
});

test('controller.start requeues interrupted processing inputs before resuming them', async () => {
  await withController(async (controller, store, _bot, app, tempDir) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
    store.setBinding('chat-1', 'thread-1', tempDir);
    store.saveQueuedTurnInput({
      queueId: 'queue-stuck',
      scopeId: 'chat-1',
      chatId: 'chat-1',
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Resume stuck item', text_elements: [] }],
      sourceSummary: 'Resume stuck item',
      telegramMessageId: null,
      status: 'processing',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await controller.start();

    assert.equal(app.startTurnCalls.length, 1);
    assert.equal(app.startTurnCalls[0]?.input?.[0]?.text, 'Resume stuck item');
    assert.equal(store.getQueuedTurnInput('queue-stuck')?.status, 'processing');
  });
});
