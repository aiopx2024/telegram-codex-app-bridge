import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAgentOutput, inferToolActivityState, normalizeTurnActivityEvent } from './activity.js';

test('normalizes agent message lifecycle notifications', () => {
  const started = normalizeTurnActivityEvent({
    method: 'item/started',
    params: {
      turnId: 'turn-1',
      item: { id: 'item-1', type: 'agentMessage', phase: 'commentary' },
    },
  });
  const delta = normalizeTurnActivityEvent({
    method: 'item/agentMessage/delta',
    params: {
      turnId: 'turn-1',
      itemId: 'item-1',
      delta: 'hello',
      phase: 'commentary',
    },
  });
  const completed = normalizeTurnActivityEvent({
    method: 'item/completed',
    params: {
      turnId: 'turn-1',
      item: { id: 'item-1', type: 'agentMessage', phase: 'final', text: 'done' },
    },
  });

  assert.deepEqual(started, {
    kind: 'agent_message_started',
    turnId: 'turn-1',
    itemId: 'item-1',
    phase: 'commentary',
    outputKind: 'commentary',
  });
  assert.deepEqual(delta, {
    kind: 'agent_message_delta',
    turnId: 'turn-1',
    itemId: 'item-1',
    delta: 'hello',
    outputKind: 'commentary',
  });
  assert.deepEqual(completed, {
    kind: 'agent_message_completed',
    turnId: 'turn-1',
    itemId: 'item-1',
    phase: 'final',
    text: 'done',
    outputKind: 'final_answer',
  });
});

test('normalizes raw tool command events into activity states', () => {
  const event = normalizeTurnActivityEvent({
    method: 'codex/event/exec_command_begin',
    params: {
      msg: {
        call_id: 'call-1',
        turn_id: 'turn-1',
        command: ['zsh', '-lc', 'rg hello src'],
        cwd: '/tmp/demo',
        parsed_cmd: [{ type: 'search', query: 'hello', path: 'src' }],
      },
    },
  });

  assert.deepEqual(event, {
    kind: 'tool_started',
    turnId: 'turn-1',
    exec: {
      callId: 'call-1',
      turnId: 'turn-1',
      command: ['zsh', '-lc', 'rg hello src'],
      cwd: '/tmp/demo',
      parsedCmd: [{ type: 'search', query: 'hello', path: 'src' }],
    },
    state: 'searching',
  });
});

test('utility classifiers keep renderer-facing categories stable', () => {
  assert.equal(classifyAgentOutput('final', true), 'final_answer');
  assert.equal(classifyAgentOutput('final_answer', true), 'final_answer');
  assert.equal(classifyAgentOutput('commentary', false), 'commentary');
  assert.equal(inferToolActivityState({
    callId: 'call-1',
    turnId: 'turn-1',
    command: ['zsh', '-lc', 'cat file.txt'],
    cwd: null,
    parsedCmd: [{ type: 'read', path: 'file.txt' }],
  }), 'reading');
});

test('normalizes failed turn completion into semantic terminal states', () => {
  const event = normalizeTurnActivityEvent({
    method: 'turn/completed',
    params: {
      turnId: 'turn-2',
      status: 'failed',
      error: { message: 'Insufficient quota for this account' },
    },
  });

  assert.deepEqual(event, {
    kind: 'turn_completed',
    turnId: 'turn-2',
    state: 'quota_exhausted',
    statusText: 'failed',
    errorText: 'Insufficient quota for this account',
  });
});

test('normalizes gemini capacity exhaustion into a rate-limited terminal state', () => {
  const event = normalizeTurnActivityEvent({
    method: 'turn/completed',
    params: {
      turnId: 'turn-3',
      status: 'error',
      error: { message: 'No capacity available for model gemini-3.1-pro-preview on the server' },
    },
  });

  assert.deepEqual(event, {
    kind: 'turn_completed',
    turnId: 'turn-3',
    state: 'rate_limited',
    statusText: 'error',
    errorText: 'No capacity available for model gemini-3.1-pro-preview on the server',
  });
});
