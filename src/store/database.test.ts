import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BridgeStore } from './database.js';

function withStore(run: (store: BridgeStore) => void): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-store-'));
  const dbPath = path.join(tmpDir, 'bridge.sqlite');
  const store = new BridgeStore(dbPath);
  try {
    run(store);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('BridgeStore persists and resolves thread bindings', () => {
  withStore((store) => {
    store.setBinding('chat-1', 'thread-1', '/tmp/project');
    const binding = store.getBinding('chat-1');

    assert.ok(binding);
    assert.deepEqual(binding, {
      chatId: 'chat-1',
      threadId: 'thread-1',
      cwd: '/tmp/project',
      updatedAt: binding.updatedAt,
    });
    assert.equal(store.findChatIdByThreadId('thread-1'), 'chat-1');
    assert.equal(store.countBindings(), 1);
  });
});

test('BridgeStore caches thread lists and pending approvals', () => {
  withStore((store) => {
    store.cacheThreadList('chat-2', [
      { threadId: 'thread-a', preview: 'Fix auth bug', cwd: '/repo/a', updatedAt: 100 },
      { threadId: 'thread-b', preview: 'Review docs', cwd: null, updatedAt: 200 },
    ]);
    assert.deepEqual(store.getCachedThread('chat-2', 2), {
      index: 2,
      threadId: 'thread-b',
      preview: 'Review docs',
      cwd: null,
      updatedAt: 200,
    });

    store.savePendingApproval({
      localId: 'approval-1',
      serverRequestId: '42',
      kind: 'command',
      chatId: 'chat-2',
      threadId: 'thread-a',
      turnId: 'turn-1',
      itemId: 'item-1',
      approvalId: null,
      reason: 'Needs confirmation',
      command: 'rm -rf build',
      cwd: '/repo/a',
      messageId: null,
      createdAt: 123,
      resolvedAt: null,
    });

    assert.equal(store.countPendingApprovals(), 1);
    store.updatePendingApprovalMessage('approval-1', 99);
    assert.equal(store.getPendingApproval('approval-1')?.messageId, 99);
    store.markApprovalResolved('approval-1');
    assert.ok(store.getPendingApproval('approval-1')?.resolvedAt !== null);
    assert.equal(store.countPendingApprovals(), 0);
  });
});
