import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.TASKBOARD_DIR = mkdtempSync(join(tmpdir(), 'tb-auto-choice-'));
const { chooseAuto, scoreAccount } = await import('../server/auto-choice.ts');
const machine = await import('../server/machine.ts');
const now = new Date().toISOString();
const account = (id: string, agent: 'claude' | 'codex' | 'antigravity', five: number, weekly: number, maxParallel = 4) => ({
  id, agent, name: id, dir: '/tmp', maxParallel, created: now,
  usage: { at: now, source: 'test', windows: [{ label: '5-hour', usedPct: five }, { label: 'weekly', usedPct: weekly }] },
});
const entry = (a: ReturnType<typeof account>, running = 0, signedIn = true) => ({ account: a, running, status: { signedIn, checkedAt: Date.now() } });

test('score uses the least spare usage or task capacity, then the average', () => {
  assert.deepEqual(scoreAccount(account('a', 'claude', 30, 60), 1), [40, 61.666666666666664]);
  assert.equal(scoreAccount(account('b', 'codex', 0, 0, 4), 3)[0], 25);
  const choice = chooseAuto([entry(account('a', 'claude', 30, 60), 1), entry(account('b', 'codex', 10, 10), 3)], 'Routine task', machine.DEFAULT_ROUTING_RULES);
  assert.equal(choice.account.id, 'a');
});

test('Auto skips limits, sign-out, full task slots, and rules it cannot check', () => {
  const limited = entry(account('limited', 'claude', 0, 0)); limited.account.limited = { at: now, note: 'limit' };
  const signedOut = entry(account('out', 'codex', 0, 0), 0, false);
  const full = entry(account('full', 'claude', 0, 0, 1), 1);
  const ruled = entry(account('ruled', 'codex', 0, 0)); ruled.account.routingRules = 'Only use for reviews.';
  const usable = entry(account('usable', 'codex', 40, 50));
  assert.equal(chooseAuto([limited, signedOut, full, ruled, usable], 'Routine task', machine.DEFAULT_ROUTING_RULES).account.id, 'usable');
  assert.throws(() => chooseAuto([limited, signedOut, full, ruled], 'Routine task', machine.DEFAULT_ROUTING_RULES), /No account can take this task/);
});

test('Auto follows the machine rule for deep planning', () => {
  const agy = entry(account('agy', 'antigravity', 0, 0));
  const codex = entry(account('codex', 'codex', 70, 70));
  assert.equal(chooseAuto([agy, codex], 'Deep planning for a service', machine.DEFAULT_ROUTING_RULES).account.id, 'codex');
  assert.equal(chooseAuto([agy, codex], 'Sort these files', machine.DEFAULT_ROUTING_RULES).account.id, 'agy');
});

test('Auto refuses custom machine rules it cannot check', () => {
  assert.throws(() => chooseAuto([entry(account('one', 'codex', 0, 0))], 'Task', 'Use only Claude for design.'), /custom machine routing rules/);
});

test('new task default is checked and saved', () => {
  assert.equal(machine.get().newTaskDefaultAgent, 'claude');
  machine.update({ newTaskDefaultAgent: 'auto' });
  assert.equal(machine.get().newTaskDefaultAgent, 'auto');
  assert.throws(() => machine.update({ newTaskDefaultAgent: 'other' as 'auto' }), /Choose Auto or a fixed agent/);
  assert.equal(machine.get().newTaskDefaultAgent, 'auto');
});
