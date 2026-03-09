import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../config.js';
import { Logger } from '../logger.js';
import { BridgeStore } from '../store/database.js';
import { BridgeController, renderApprovalDetailsMessage, renderApprovalMessage } from './controller.js';
import type { PendingApprovalRecord } from '../types.js';
import type { TelegramCallbackEvent } from '../telegram/gateway.js';

function makeApproval(kind: PendingApprovalRecord['kind'] = 'command'): PendingApprovalRecord {
  return {
    localId: 'aa11bb22',
    serverRequestId: 'request-1',
    kind,
    chatId: 'chat-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    approvalId: 'server-approval-1',
    reason: 'This may modify the repo.',
    command: kind === 'command' ? 'rm -rf build && pnpm install' : null,
    cwd: '/tmp/demo',
    summary: kind === 'command' ? 'rm -rf build && pnpm install' : '2 file(s): src/app.ts, package.json',
    riskLevel: kind === 'command' ? 'high' : 'medium',
    details: kind === 'command'
      ? {
          command: 'rm -rf build && pnpm install',
          cwd: '/tmp/demo',
          parsedCmd: [],
        }
      : {
          paths: ['src/app.ts', 'package.json'],
          counts: { create: 0, update: 2, delete: 0 },
        },
    messageId: 55,
    createdAt: Date.now(),
    resolvedAt: null,
  };
}

test('renderApprovalMessage shows risk and summary for command approvals', () => {
  const text = renderApprovalMessage('en', makeApproval('command'));

  assert.match(text, /Approval requested: command/);
  assert.match(text, /Risk: High/);
  assert.match(text, /Summary: rm -rf build && pnpm install/);
});

test('renderApprovalDetailsMessage lists changed paths for file approvals', () => {
  const text = renderApprovalDetailsMessage('en', makeApproval('fileChange'));

  assert.match(text, /Approval details/);
  assert.match(text, /Paths: src\/app\.ts, package\.json/);
  assert.match(text, /Change counts: 2 update/);
});

test('approval details callback edits the existing approval card in place', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-approval-'));
  const store = new BridgeStore(path.join(tempDir, 'bridge.sqlite'));
  const bot = {
    answers: [] as string[],
    edits: [] as Array<{ messageId: number; text: string; keyboard: unknown }>,
    async answerCallback(_id: string, text: string) {
      this.answers.push(text);
    },
    async editMessage(_chatId: string, messageId: number, text: string, keyboard?: unknown) {
      this.edits.push({ messageId, text, keyboard: keyboard ?? null });
    },
    async sendMessage() { return 0; },
    async sendHtmlMessage() { return 0; },
    async editHtmlMessage() {},
    async clearMessageInlineKeyboard() {},
    async deleteMessage() {},
    async sendTypingInThread() {},
    async sendMessageDraft() {},
    async start() {},
    stop() {},
    username: 'bot',
  };
  const app = {
    isConnected() {
      return true;
    },
    getUserAgent() {
      return 'test-agent';
    },
    async respond() {},
  };
  const controller = new BridgeController(
    makeConfig(tempDir),
    store,
    new Logger('error', path.join(tempDir, 'bridge.log')),
    bot as any,
    app as any,
  );
  store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
  store.savePendingApproval(makeApproval('fileChange'));

  await (controller as any).handleCallback(makeCallback('approval:aa11bb22:details'));
  assert.match(bot.edits[0]?.text ?? '', /Approval details/);
  assert.equal((bot.edits[0]?.keyboard as Array<Array<{ callback_data: string }>>)?.[1]?.[0]?.callback_data, 'approval:aa11bb22:back');

  await (controller as any).handleCallback(makeCallback('approval:aa11bb22:back'));
  assert.match(bot.edits[1]?.text ?? '', /Approval requested: file change/);
  assert.match(bot.answers.at(-1) ?? '', /summary/i);

  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

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

function makeCallback(data: string): TelegramCallbackEvent {
  return {
    chatId: 'chat-1',
    topicId: null,
    scopeId: 'chat-1',
    userId: 'user-1',
    data,
    callbackQueryId: 'cb-1',
    messageId: 55,
    languageCode: 'en',
  };
}
