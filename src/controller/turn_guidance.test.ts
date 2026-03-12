import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Logger } from '../logger.js';
import { BridgeStore } from '../store/database.js';
import { TurnRegistry } from './bridge_runtime.js';
import { TurnGuidanceCoordinator } from './turn_guidance.js';

test('queued guidance prompt expires and removes its temporary card', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-guidance-'));
  const store = new BridgeStore(path.join(tempDir, 'bridge.sqlite'));
  try {
    const turns = new TurnRegistry();
    const bot = {
      edits: [] as Array<{ messageId: number; text: string }>,
      deleted: [] as Array<{ chatId: string; messageId: number }>,
      cleared: [] as Array<{ chatId: string; messageId: number }>,
      async sendMessage() {
        return 55;
      },
      async editMessage(_chatId: string, messageId: number, text: string) {
        this.edits.push({ messageId, text });
      },
      async deleteMessage(chatId: string, messageId: number) {
        this.deleted.push({ chatId, messageId });
      },
      async clearMessageButtons(chatId: string, messageId: number) {
        this.cleared.push({ chatId, messageId });
      },
    };
    const guidance = new TurnGuidanceCoordinator({
      logger: new Logger('error', path.join(tempDir, 'bridge.log')),
      store,
      turns,
      app: {
        async steerTurn() {
          return { turnId: 'turn-1' };
        },
      },
      messages: bot,
      localeForChat: () => 'en',
      answerCallback: async () => undefined,
      syncGuidedPlanQueueDepth: async () => undefined,
      updateStatus: () => undefined,
      buildTurnInput: async () => [{ type: 'text', text: 'unused', text_elements: [] }],
      resolveActiveTurnBinding: () => ({ chatId: 'chat-1', threadId: 'thread-1', cwd: tempDir, updatedAt: Date.now() }),
      promptTimeoutMs: 20,
    });

    store.saveQueuedTurnInput({
      queueId: 'queue-1',
      scopeId: 'chat-1',
      chatId: 'chat-1',
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Follow up', text_elements: [] }],
      sourceSummary: 'Follow up',
      telegramMessageId: 41,
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await guidance.maybeOfferQueuedGuidancePrompt(store.getQueuedTurnInput('queue-1')!, 'turn-1', 'en');

    await new Promise((resolve) => {
      setTimeout(resolve, 80);
    });

    assert.equal(bot.edits.length, 1);
    assert.equal(bot.deleted[0]?.messageId, 41);
    assert.equal(store.getQueuedTurnInput('queue-1')?.telegramMessageId, null);

    guidance.stop();
  } finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
