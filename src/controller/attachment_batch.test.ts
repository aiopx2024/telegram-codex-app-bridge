import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../config.js';
import { Logger } from '../logger.js';
import { BridgeStore } from '../store/database.js';
import type { TelegramCallbackEvent, TelegramTextEvent } from '../telegram/gateway.js';
import type { TelegramInboundAttachment } from '../telegram/media.js';
import { createBridgeComposition } from './composition.js';

function withComposition(run: (
  composition: ReturnType<typeof createBridgeComposition>,
  store: BridgeStore,
  bot: ReturnType<typeof makeBot>,
  app: ReturnType<typeof makeApp>,
  tempDir: string,
) => Promise<void>): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-attach-'));
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
  return Promise.resolve(run(composition, store, bot, app, tempDir)).finally(async () => {
    await composition.turnLifecycle.abandonAllTurns();
    composition.turnGuidance.stop();
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
    answers: [] as string[],
    messages: [] as Array<{ chatId: string; text: string; keyboard: unknown }>,
    messageEdits: [] as Array<{ chatId: string; messageId: number; text: string; keyboard: unknown }>,
    typings: [] as Array<{ chatId: string; topicId: number | null | undefined }>,
    downloads: [] as Array<{ remotePath: string; localPath: string }>,
    async answerCallback(_id: string, text: string) {
      this.answers.push(text);
    },
    async sendMessage(chatId: string, text: string, keyboard?: unknown) {
      this.messages.push({ chatId, text, keyboard: keyboard ?? null });
      nextMessageId += 1;
      return nextMessageId;
    },
    async editMessage(chatId: string, messageId: number, text: string, keyboard?: unknown) {
      this.messageEdits.push({ chatId, messageId, text, keyboard: keyboard ?? null });
    },
    async sendHtmlMessage() {
      nextMessageId += 1;
      return nextMessageId;
    },
    async editHtmlMessage() {},
    async clearMessageInlineKeyboard() {},
    async deleteMessage() {},
    async sendTypingInThread(chatId: string, topicId?: number | null) {
      this.typings.push({ chatId, topicId });
    },
    async sendMessageDraft() {},
    async getFile(fileId: string) {
      return {
        file_path: `photos/${fileId}.jpg`,
        file_size: 512,
      };
    },
    async downloadResolvedFile(remotePath: string, localPath: string) {
      await fsp.mkdir(path.dirname(localPath), { recursive: true });
      await fsp.writeFile(localPath, 'attachment');
      this.downloads.push({ remotePath, localPath });
    },
    async start() {},
    stop() {},
    username: 'bot',
  };
}

function makeApp() {
  return {
    startTurnCalls: [] as any[],
    isConnected() {
      return true;
    },
    getUserAgent() {
      return 'test-agent';
    },
    async startTurn(options: any) {
      this.startTurnCalls.push(options);
      return { id: `turn-${this.startTurnCalls.length}`, status: 'running' };
    },
  };
}

function makeTextEvent(
  text: string,
  attachments: TelegramInboundAttachment[] = [],
  mediaGroupId: string | null = null,
): TelegramTextEvent {
  return {
    chatId: 'chat-1',
    topicId: null,
    mediaGroupId,
    scopeId: 'chat-1',
    chatType: 'private',
    userId: 'user-1',
    text,
    messageId: 1,
    attachments,
    entities: [],
    replyToBot: false,
    languageCode: 'en',
  };
}

function makeCallbackEvent(data: string, messageId: number): TelegramCallbackEvent {
  return {
    chatId: 'chat-1',
    topicId: null,
    scopeId: 'chat-1',
    userId: 'user-1',
    data,
    callbackQueryId: 'cb-1',
    messageId,
    languageCode: 'en',
  };
}

function makePhotoAttachment(id: string): TelegramInboundAttachment {
  return {
    kind: 'photo',
    fileId: id,
    fileUniqueId: `${id}-unique`,
    fileName: null,
    mimeType: 'image/jpeg',
    fileSize: 512,
    width: 1280,
    height: 720,
    durationSeconds: null,
    isAnimated: false,
    isVideo: false,
  };
}

function seedBinding(composition: ReturnType<typeof createBridgeComposition>, store: BridgeStore, cwd: string): void {
  store.setBinding('chat-1', 'thread-1', cwd);
  composition.attachedThreads.add('thread-1');
  store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
}

test('attachment uploads are staged without starting a turn and albums merge into one batch', async () => {
  await withComposition(async (composition, store, bot, app, tempDir) => {
    seedBinding(composition, store, tempDir);

    await composition.telegramRouter.handleText(makeTextEvent('', [makePhotoAttachment('photo-1')], 'album-1'));
    await composition.telegramRouter.handleText(makeTextEvent('', [makePhotoAttachment('photo-2')], 'album-1'));

    const batch = store.getLatestPendingAttachmentBatch('chat-1');
    assert.ok(batch);
    assert.equal(batch.attachments.length, 2);
    assert.equal(batch.mediaGroupId, 'album-1');
    assert.equal(app.startTurnCalls.length, 0);
    assert.match(bot.messages[0]?.text ?? '', /Saved Telegram attachments/);
    assert.equal(bot.messageEdits.length, 1);
  });
});

test('the next plain-text message consumes the pending attachments and starts a turn', async () => {
  await withComposition(async (composition, store, _bot, app, tempDir) => {
    seedBinding(composition, store, tempDir);

    await composition.telegramRouter.handleText(makeTextEvent('System screenshot', [makePhotoAttachment('photo-1')]));
    await composition.telegramRouter.handleText(makeTextEvent('Explain the failure'));

    assert.equal(app.startTurnCalls.length, 1);
    assert.match(app.startTurnCalls[0]?.input?.[0]?.text ?? '', /Upload note:/);
    assert.match(app.startTurnCalls[0]?.input?.[0]?.text ?? '', /Current request:/);
    assert.match(app.startTurnCalls[0]?.input?.[0]?.text ?? '', /Explain the failure/);
    assert.equal(app.startTurnCalls[0]?.input?.[1]?.type, 'localImage');
    assert.equal(store.getLatestPendingAttachmentBatch('chat-1'), null);
    assert.equal(store.getPendingAttachmentBatch(store.listPendingAttachmentBatches('chat-1')[0]!.batchId)?.status, 'consumed');
  });
});

test('attachment batch callbacks can clear the pending batch', async () => {
  await withComposition(async (composition, store, bot, _app, tempDir) => {
    seedBinding(composition, store, tempDir);

    await composition.telegramRouter.handleText(makeTextEvent('', [makePhotoAttachment('photo-1')]));

    const batch = store.getLatestPendingAttachmentBatch('chat-1');
    assert.ok(batch?.receiptMessageId);

    await composition.telegramRouter.handleCallback(
      makeCallbackEvent(`attach:${batch!.batchId}:clear`, batch!.receiptMessageId!),
    );

    assert.equal(store.getLatestPendingAttachmentBatch('chat-1'), null);
    assert.equal(store.getPendingAttachmentBatch(batch!.batchId)?.status, 'cleared');
    assert.match(bot.answers.at(-1) ?? '', /Cleared saved attachments/);
  });
});
