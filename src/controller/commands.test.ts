import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from './commands.js';

test('parseCommand parses plain slash commands', () => {
  assert.deepEqual(parseCommand('/threads'), { name: 'threads', args: [] });
});

test('parseCommand strips bot mentions and preserves args', () => {
  assert.deepEqual(parseCommand('/open@mybot 4 extra'), { name: 'open', args: ['4', 'extra'] });
});

test('parseCommand preserves model and effort arguments', () => {
  assert.deepEqual(parseCommand('/model o4-mini'), { name: 'model', args: ['o4-mini'] });
  assert.deepEqual(parseCommand('/effort xhigh'), { name: 'effort', args: ['xhigh'] });
});

test('parseCommand ignores non-commands and empty command names', () => {
  assert.equal(parseCommand('hello'), null);
  assert.equal(parseCommand('/'), null);
});
