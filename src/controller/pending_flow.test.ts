import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../config.js';
import { Logger } from '../logger.js';
import { BridgeStore } from '../store/database.js';
import type { TelegramCallbackEvent } from '../telegram/gateway.js';
import type { PendingUserInputRecord } from '../types.js';
import { createBridgeComposition } from './composition.js';

function withComposition(run: (
  composition: ReturnType<typeof createBridgeComposition>,
  store: BridgeStore,
  bot: ReturnType<typeof makeBot>,
  app: ReturnType<typeof makeApp>,
) => Promise<void>): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-pending-flow-'));
  const store = new BridgeStore(path.join(tempDir, 'bridge.sqlite'));
  const bot = makeBot();
  const app = makeApp();
  const composition = createBridgeComposition(
    makeConfig(tempDir),
    store,
    new Logger('error', path.join(tempDir, 'bridge.log')),
    bot as any,
    app as any,
  );
  return Promise.resolve(run(composition, store, bot, app)).finally(() => {
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
    edits: [] as Array<{ messageId: number; text: string }>,
    messages: [] as string[],
    async answerCallback(_id: string, text: string) {
      this.answers.push(text);
    },
    async editHtmlMessage(_chatId: string, messageId: number, text: string) {
      this.edits.push({ messageId, text });
    },
    async sendMessage(_chatId: string, text: string) {
      this.messages.push(text);
      return 200;
    },
  };
}

function makeApp() {
  return {
    responses: [] as any[],
    responseErrors: [] as Array<{ id: string; message: string }>,
    isConnected() {
      return true;
    },
    getUserAgent() {
      return 'test-agent';
    },
    async respond(id: string, result: unknown) {
      this.responses.push({ id, result });
    },
    async respondError(id: string, message: string) {
      this.responseErrors.push({ id, message });
    },
  };
}

function makeCallback(messageId = 77): TelegramCallbackEvent {
  return {
    chatId: 'chat-1',
    topicId: null,
    scopeId: 'chat-1',
    userId: 'user-1',
    data: '',
    callbackQueryId: 'cb-1',
    messageId,
    languageCode: 'en',
  };
}

function makeRecord(overrides: Partial<PendingUserInputRecord> = {}): PendingUserInputRecord {
  return {
    localId: 'input-1',
    serverRequestId: 'request-1',
    chatId: 'chat-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    messageId: 77,
    questions: [
      {
        id: 'direction',
        header: 'Choose direction',
        question: 'Which path should Codex take first?',
        isOther: true,
        isSecret: false,
        options: [
          { label: 'Minimal patch', description: 'Use the smallest safe change.' },
          { label: 'Broader cleanup', description: 'Refactor related code while touching it.' },
        ],
      },
    ],
    answers: {},
    currentQuestionIndex: 0,
    awaitingFreeText: false,
    createdAt: Date.now(),
    resolvedAt: null,
    ...overrides,
  };
}

test('last pending-input answer moves into review and waits for explicit submit', async () => {
  await withComposition(async (composition, store, bot, app) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
    store.savePendingUserInput(makeRecord());

    await composition.approvalsAndInputs.handlePendingUserInputCallback(makeCallback(), 'input-1', 'option:0', 'en');

    const record = store.getPendingUserInput('input-1');
    assert.equal(record?.resolvedAt, null);
    assert.equal(record?.currentQuestionIndex, 1);
    assert.deepEqual(app.responses, []);
    assert.match(bot.edits.at(-1)?.text ?? '', /Review answers/);

    await composition.approvalsAndInputs.handlePendingUserInputCallback(makeCallback(), 'input-1', 'submit', 'en');

    assert.equal(app.responses.length, 1);
    const submitted = (app.responses as Array<{ id: string; result: unknown }>)[0];
    assert.deepEqual(submitted?.result, {
      answers: {
        direction: { answers: ['Minimal patch'] },
      },
    });
    assert.ok(store.getPendingUserInput('input-1')?.resolvedAt);
  });
});

test('pending-input back rewinds to the previous question and clears later answers', async () => {
  await withComposition(async (composition, store, bot) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
    store.savePendingUserInput(makeRecord({
      questions: [
        ...makeRecord().questions,
        {
          id: 'risk',
          header: 'Risk level',
          question: 'How aggressive should the patch be?',
          isOther: false,
          isSecret: false,
          options: null,
        },
      ],
      answers: {
        direction: ['Minimal patch'],
      },
      currentQuestionIndex: 1,
    }));

    await composition.approvalsAndInputs.handlePendingUserInputCallback(makeCallback(), 'input-1', 'back', 'en');

    const record = store.getPendingUserInput('input-1');
    assert.equal(record?.currentQuestionIndex, 0);
    assert.deepEqual(record?.answers, {});
    assert.match(bot.edits.at(-1)?.text ?? '', /Choose direction/);
  });
});

test('pending-input cancel sends an explicit respondError and resolves the record', async () => {
  await withComposition(async (composition, store, bot, app) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
    store.savePendingUserInput(makeRecord());

    await composition.approvalsAndInputs.handlePendingUserInputCallback(makeCallback(), 'input-1', 'cancel', 'en');

    assert.equal(app.responseErrors.length, 1);
    assert.match(app.responseErrors[0]?.message ?? '', /cancelled/);
    assert.ok(store.getPendingUserInput('input-1')?.resolvedAt);
    assert.match(bot.edits.at(-1)?.text ?? '', /Input request cancelled/);
  });
});

test('requestUserInput is rejected in default mode and no pending card is created', async () => {
  await withComposition(async (composition, store, bot, app) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
    store.setChatCollaborationMode('chat-1', 'default');
    store.setBinding('chat-1', 'thread-1', '/tmp/demo');

    await composition.codexRouter.handleServerRequest({
      id: 'request-2',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        questions: [{
          id: 'check',
          header: 'Execution check',
          question: 'Run now?',
          options: [{ label: 'Run now', description: 'Proceed' }],
        }],
      },
    });

    assert.equal(store.listPendingUserInputs('chat-1').length, 0);
    assert.equal(app.responseErrors.length, 1);
    assert.match(app.responseErrors[0]?.message ?? '', /only available in plan mode/i);
    assert.match(bot.messages.at(-1) ?? '', /disabled in Default mode/i);
  });
});

test('switching mode to default clears unresolved pending input cards', async () => {
  await withComposition(async (composition, store, bot, app) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
    store.setChatCollaborationMode('chat-1', 'plan');
    store.savePendingUserInput(makeRecord());

    await composition.settings.handleModeCommand({ scopeId: 'chat-1' } as any, 'en', ['default']);

    assert.equal(store.listPendingUserInputs('chat-1').length, 0);
    assert.equal(app.responseErrors.length, 1);
    assert.match(bot.edits.at(-1)?.text ?? '', /Input request cancelled/);
  });
});
