import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Task } from '../server/store.ts';
import type { Account } from '../server/accounts.ts';

const root = mkdtempSync(join(tmpdir(), 'tb-auto-move-'));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
const { chooseLimitTarget } = await import('../server/auto-move.ts');
const machine = await import('../server/machine.ts');
const { limitFromScreen, codexRolloutLimit } = await import('../server/agent-limits.ts');
const { writeFileSync } = await import('node:fs');
const task = { agent: 'claude', account: 'source', title: 'Fix the page', desc: 'Continue the work.' } as Task;
function entry(id: string, agent: Account['agent'] = 'claude', used = 50) {
  const account: Account = { id, agent, name: id, dir: root, maxParallel: 4, created: new Date().toISOString(),
    usage: { at: new Date().toISOString(), source: 'test', windows: [{ label: '5-hour', usedPct: used }, { label: 'weekly', usedPct: used }] } };
  return { account, running: 0, status: { signedIn: true, checkedAt: Date.now() } };
}
const choose = (inputs: ReturnType<typeof entry>[], mode: machine.AutoMoveOnLimit = 'any-kind', t = task, rules = machine.DEFAULT_ROUTING_RULES) => chooseLimitTarget(inputs, t, mode, rules);

test('same kind takes precedence even when another kind has more capacity', () => {
  assert.equal(choose([entry('source'), entry('codex', 'codex', 0), entry('claude', 'claude', 90)]).account.id, 'claude');
  assert.equal(choose([entry('codex', 'codex')]).account.id, 'codex');
  assert.throws(() => choose([entry('codex', 'codex')], 'same-kind'), /No account/);
  assert.throws(() => choose([entry('claude')], 'off'), /off/);
});

test('exclude unavailable accounts and never return to an attempted account', () => {
  const limited = entry('limited'); limited.account.limited = { at: new Date().toISOString(), note: 'credit' };
  const stale = entry('stale'); stale.account.usage!.at = '2020-01-01T00:00:00Z';
  const missing = entry('missing'); delete missing.account.usage;
  const signedOut = entry('out'); signedOut.status.signedIn = false;
  const full = entry('full'); full.running = 4;
  const usageFull = entry('usage-full', 'claude', 100);
  const ruled = entry('ruled'); ruled.account.routingRules = 'Only use for reviews.';
  const inputs = [limited, stale, missing, signedOut, full, usageFull, ruled, entry('source'), entry('attempted')];
  const t = { ...task, autoMoveAttempts: ['attempted'] };
  assert.throws(() => choose(inputs, 'any-kind', t), /No account/);
  assert.equal(choose([...inputs, entry('new', 'codex')], 'any-kind', t).account.id, 'new');
  const restored = JSON.parse(JSON.stringify(t));
  assert.throws(() => choose([entry('attempted')], 'same-kind', restored), /No account/);
});

test('routing rules and computer use constrain fallback', () => {
  assert.throws(() => choose([entry('one')], 'same-kind', task, 'Use only my work account.'), /custom machine routing rules/);
  assert.throws(() => choose([entry('agy', 'antigravity')], 'any-kind', { ...task, title: 'Deep planning' }), /machine routing rule/);
  assert.throws(() => choose([entry('agy', 'antigravity')], 'any-kind', { ...task, computerUse: true }), /No account/);
  assert.equal(choose([entry('agy', 'antigravity')]).account.id, 'agy');
});

test('settings default off, validate values, and persist the chosen mode', () => {
  assert.equal(machine.get().accounts.autoMoveOnLimit, 'off');
  for (const mode of ['same-kind', 'any-kind', 'off'] as const) {
    machine.update({ autoMoveOnLimit: mode });
    assert.equal(JSON.parse(readFileSync(join(root, 'state', 'machine.json'), 'utf8')).accounts.autoMoveOnLimit, mode);
  }
  assert.throws(() => machine.update({ autoMoveOnLimit: 'yes' as any }), /Choose Off/);
  for (const invalid of [undefined, null, true, 'yes']) assert.equal(machine.readAutoMoveOnLimit(invalid), 'off');
});

test('weekly limits match, but overload notes and temporary rate limits do not', () => {
  for (const agent of ['claude', 'codex'] as const) {
    assert.equal(limitFromScreen(agent, 'You have hit your weekly limit')?.kind, 'limit');
    assert.equal(limitFromScreen(agent, 'Selected model is at capacity'), null);
    assert.equal(limitFromScreen(agent, 'API Error: overloaded'), null);
    assert.equal(limitFromScreen(agent, '> Explain You have hit your weekly limit'), null);
  }
  const path = join(root, 'temporary.jsonl');
  writeFileSync(path, JSON.stringify({ timestamp: new Date().toISOString(), payload: { type: 'task_complete', error: { codex_error_info: 'rate_limit', message: 'Too many requests. Retry later.' } } }));
  assert.equal(codexRolloutLimit(path), null);
  const temporary = readFileSync(path, 'utf8');
  writeFileSync(path, JSON.stringify({ payload: { type: 'token_count', rate_limits: { rate_limit_reached_type: 'workspace_member_credits_depleted' } } }) + '\n' + temporary);
  assert.equal(codexRolloutLimit(path), null);
  writeFileSync(path, JSON.stringify({ payload: { type: 'task_complete', error: { codex_error_info: 'usage_limit_exceeded' } } }) + '\n' + JSON.stringify({ payload: { type: 'task_started' } }));
  assert.equal(codexRolloutLimit(path), null);
});
