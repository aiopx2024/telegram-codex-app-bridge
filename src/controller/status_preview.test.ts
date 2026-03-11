import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../config.js';
import { Logger } from '../logger.js';
import { BridgeStore } from '../store/database.js';
import { createBridgeComposition } from './composition.js';

function withComposition(run: (
  composition: ReturnType<typeof createBridgeComposition>,
  store: BridgeStore,
  bot: ReturnType<typeof makeBot>,
) => Promise<void>): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-status-preview-'));
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
  let nextMessageId = 200;
  return {
    sendCalls: [] as Array<{ chatId: string; text: string }>,
    editCalls: [] as Array<{ chatId: string; messageId: number; text: string }>,
    deleteCalls: [] as Array<{ chatId: string; messageId: number }>,
    sendError: null as Error | null,
    editError: null as Error | null,
    deleteError: null as Error | null,
    async sendMessage(chatId: string, text: string) {
      this.sendCalls.push({ chatId, text });
      if (this.sendError) {
        throw this.sendError;
      }
      nextMessageId += 1;
      return nextMessageId;
    },
    async editMessage(chatId: string, messageId: number, text: string) {
      this.editCalls.push({ chatId, messageId, text });
      if (this.editError) {
        throw this.editError;
      }
    },
    async deleteMessage(chatId: string, messageId: number) {
      this.deleteCalls.push({ chatId, messageId });
      if (this.deleteError) {
        throw this.deleteError;
      }
    },
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

function makeActiveTurn(overrides: Record<string, unknown> = {}): any {
  return {
    scopeId: 'chat-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    previewMessageId: 88,
    previewActive: true,
    interruptRequested: false,
    statusMessageText: 'old status',
    statusNeedsRebase: false,
    renderRetryTimer: null,
    ...overrides,
  };
}

test('ensureStatusMessage keeps existing preview when edit fails transiently', async () => {
  await withComposition(async (composition, store, bot) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
    bot.editError = new Error('Too Many Requests: retry after 31');
    const scheduleRenderRetry = (active: any) => {
      active._retryCount = (active._retryCount ?? 0) + 1;
    };
    (composition.statusPreview as any).host.scheduleRenderRetry = scheduleRenderRetry;

    const active = makeActiveTurn();
    await composition.statusPreview.ensureStatusMessage(active, 'Thinking...');

    assert.equal(bot.editCalls.length, 1);
    assert.equal(bot.sendCalls.length, 0);
    assert.equal(active.previewActive, true);
    assert.equal(active.previewMessageId, 88);
    assert.equal(active._retryCount, 1);
  });
});

test('rebaseStatusMessage does not create a new preview when old preview delete fails', async () => {
  await withComposition(async (composition, store, bot) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
    bot.deleteError = new Error('Too Many Requests: retry after 31');
    (composition.statusPreview as any).host.scheduleRenderRetry = (active: any) => {
      active._retryCount = (active._retryCount ?? 0) + 1;
    };

    const active = makeActiveTurn({ statusNeedsRebase: true });
    await composition.statusPreview.rebaseStatusMessage(active, 'Thinking...');

    assert.equal(bot.deleteCalls.length, 1);
    assert.equal(bot.sendCalls.length, 0);
    assert.equal(active.previewActive, true);
    assert.equal(active.previewMessageId, 88);
    assert.equal(active.statusNeedsRebase, true);
    assert.equal(active._retryCount, 1);
  });
});

test('ensureStatusMessage recreates preview only when old message is gone', async () => {
  await withComposition(async (composition, store, bot) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
    bot.editError = new Error('Bad Request: message to edit not found');

    const active = makeActiveTurn();
    await composition.statusPreview.ensureStatusMessage(active, 'Thinking...');

    assert.equal(bot.editCalls.length, 1);
    assert.equal(bot.sendCalls.length, 1);
    assert.equal(active.previewActive, true);
    assert.equal(active.previewMessageId, 201);
    assert.equal(active.statusMessageText, 'Thinking...');
    assert.equal(active.statusNeedsRebase, false);
  });
});
