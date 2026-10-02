import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// No credit, limits and stale usage, without a server. The folders are temporary; nothing reads the real accounts.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-account-limits-test-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-account-limits-test-${process.pid}`;
mkdirSync(join(root, 'state'), { recursive: true });
// fake CLIs: every account reports that it is signed in, and no real CLI runs
const bin = join(root, 'bin'); mkdirSync(bin);
for (const name of ['claude', 'codex', 'agy']) { writeFileSync(join(bin, name), `#!/bin/sh\n[ "$1" = auth ] && echo '{"loggedIn":true}' || echo 'Logged in using ChatGPT'\n`); chmodSync(join(bin, name), 0o755); }
process.env.PATH = `${bin}:${process.env.PATH}`;
const now = new Date().toISOString();
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600000).toISOString();
const dir = (id: string) => join(root, 'home', id);
const fixtureAccounts = [
  // Codex accounts are marked limited only by the tests below; the defaults have a fixture mark so pick() asks no CLI
  { id: 'codex-work', agent: 'codex', name: 'Work Codex', dir: dir('codex-work'), maxParallel: 8, created: now,
    usage: { windows: [{ label: 'weekly', usedPct: 97, resetsAt: Date.now() + 86400000 }], at: hoursAgo(43), source: 'Codex session file', plan: 'team' } },
  { id: 'codex-default', agent: 'codex', name: 'Codex (default)', dir: dir('codex-default'), isDefault: true, maxParallel: 20, created: now,
    usage: { windows: [{ label: 'weekly', usedPct: 39 }], at: now, source: 'Codex session file' } },
  { id: 'claude-default', agent: 'claude', name: 'Claude Code (default)', dir: dir('claude'), isDefault: true, maxParallel: 8, created: now, limited: { at: now, note: 'fixture' } },
  { id: 'antigravity-default', agent: 'antigravity', name: 'Antigravity (default)', dir: dir('agy'), isDefault: true, maxParallel: 8, created: now, limited: { at: now, note: 'fixture' } },
];
writeFileSync(join(root, 'state', 'accounts.json'), JSON.stringify(fixtureAccounts));
writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ name: 'account-limits-test', controller: { autostart: false, remoteControl: false } }));

const accounts = await import('../server/accounts.ts');
const limits = await import('../server/agent-limits.ts');
const agents = await import('../server/agents.ts');
const store = await import('../server/store.ts');

// The lines Codex 0.160.0 wrote for task 163 on an account without credit (ids and prompt text replaced).
const depleted = (at: string) => JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'premium', limit_name: null, primary: null, secondary: null, credits: { has_credits: false, unlimited: false, balance: null }, individual_limit: null, spend_control_reached: null, plan_type: null, rate_limit_reached_type: 'workspace_member_credits_depleted' } } });
const failed = (at: string) => JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: null, error: { message: 'Your workspace is out of credits. Ask your workspace owner to refill in order to continue.', codex_error_info: 'usage_limit_exceeded' } } });
const working = (at: string, pct: number) => JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: pct, window_minutes: 10080, resets_at: Math.round(Date.now() / 1000) + 86400 }, secondary: null, credits: { has_credits: false }, plan_type: 'team', rate_limit_reached_type: null } } });
const done = (at: string) => JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'task_complete', turn_id: 't0', last_agent_message: 'Done.' } });
function rollout(account: string, name: string, lines: string[]) {
  const d = join(dir(account), 'sessions', '2026', '10', '01'); mkdirSync(d, { recursive: true });
  const f = join(d, `rollout-${name}.jsonl`); writeFileSync(f, lines.join('\n') + '\n'); return f;
}

test('the screen texts of no credit and limits are read; a prompt that quotes them is not', () => {
  // Codex 0.160.0, task 163 (spaces as tmux shows them)
  const codex = '  › Ask Codex to do anything\n■ Your workspace is out of credits. Ask your workspace owner to refill in order to continue.\n\n  Usage limit reached\n  Request a limit increase from your owner to continue using codex. Request increase?\n› 1. Yes (y)\n  2. No (default) (n)';
  assert.deepEqual(limits.limitFromScreen('codex', codex), { kind: 'credit', text: 'Your workspace is out of credits. Ask your workspace owner to refill in order to continue.' });
  assert.equal(limits.limitFromScreen('codex', '  Usage limit reached\n  Request increase?')!.kind, 'limit');
  // agy, task 33
  assert.equal(limits.limitFromScreen('antigravity', '⚠ Individual quota reached. Please upgrade your subscription to increase your limits.')!.kind, 'limit');
  assert.equal(limits.limitFromScreen('claude', '  ⎿  API Error: Credit balance is too low')!.kind, 'credit');
  assert.equal(limits.limitFromScreen('claude', '  ⎿  OAuth token has expired. Please run /login')!.kind, 'login');
  // a prompt that mentions the text, as the agents show a prompt (task 168 asked about exactly this)
  assert.equal(limits.limitFromScreen('codex', '› Find why "Your workspace is out of credits" shows up on tasks 163 and 164'), null);
  assert.equal(limits.limitFromScreen('claude', '> What does "Credit balance is too low" mean?'), null);
  assert.equal(limits.limitFromScreen('codex', 'I checked the usage limit reached flag in the code.'), null);
});

test('a Codex rollout file shows a failed first turn, and a later failure after work', () => {
  const t0 = new Date(Date.now() - 60000).toISOString(), t1 = new Date().toISOString();
  const first = limits.codexRolloutLimit(rollout('scratch', 'first', [depleted(t1), failed(t1)]))!;
  assert.equal(first.kind, 'credit'); assert.equal(first.neverWorked, true); assert.equal(first.at, t1);
  assert.match(first.text, /^Your workspace is out of credits\. .* \(workspace_member_credits_depleted\)$/);
  const later = limits.codexRolloutLimit(rollout('scratch', 'later', [working(t0, 50), done(t0), depleted(t1), failed(t1)]))!;
  assert.equal(later.neverWorked, false);
  assert.equal(limits.codexRolloutLimit(rollout('scratch', 'fine', [working(t0, 50), done(t1)])), null);
});

test('refreshCodexUsage marks an account without credit, keeps a cleared mark cleared, and clears it after a working turn', () => {
  const a = accounts.get('codex-work')!;
  const t1 = new Date(Date.now() - 1000).toISOString();
  rollout('codex-work', 'a', [depleted(t1), failed(t1)]);
  accounts.refreshCodexUsage();
  assert.match(a.limited!.note, /^Codex: Your workspace is out of credits\. .*\(workspace_member_credits_depleted\)$/);
  assert.equal(a.usage!.at, fixtureAccounts[0].usage!.at);
  assert.match(accounts.unavailable(a, 0)!, /^Account codex-work stopped at a usage limit at .*out of credits/);
  // the user clears the mark: the same old report does not set it again
  accounts.clearLimited(a.id); accounts.refreshCodexUsage();
  assert.equal(a.limited, undefined);
  // a newer failure sets it again; a newer working turn clears it
  const t2 = new Date(Date.now() + 1000).toISOString();
  rollout('codex-work', 'b', [depleted(t2), failed(t2)]); accounts.refreshCodexUsage();
  assert.ok(a.limited);
  const t3 = new Date(Date.now() + 2000).toISOString();
  rollout('codex-work', 'c', [working(t3, 12), done(t3)]); accounts.refreshCodexUsage();
  assert.equal(a.limited, undefined); assert.equal(a.usage!.windows[0].usedPct, 12); assert.equal(accounts.usageStale(a), false);
});

test('old usage counts as unknown, not as free, and its age is shown', async () => {
  const work = accounts.get('codex-work')!;
  rmSync(join(dir('codex-work'), 'sessions'), { recursive: true }); // no newer session file: the numbers stay old
  work.usage = { windows: [{ label: 'weekly', usedPct: 5 }], at: hoursAgo(43), source: 'Codex session file' };
  assert.equal(accounts.usageStale(work), true);
  assert.equal(accounts.usageStale(accounts.get('codex-default')!), false);
  // both run no task; the default account has fresh numbers (39%), the other old low numbers (5%, 43 h old)
  const running = (_id: string) => 0;
  accounts.get('codex-default')!.maxParallel = 20;
  const picked = await accounts.pick('codex', running);
  assert.equal(picked.account.id, 'codex-default', picked.why);
  assert.match(accounts.usageSummary(running), /codex-work .* STALE \(43 h old; count as unknown\)/);
  assert.match(accounts.alternatives(accounts.get('codex-default')!, running), /codex-work \(Work Codex, 0 running, usage unknown, data 43 h old\)/);
});

test('an account you chose is refused with the cause and the accounts that can run the task', async () => {
  accounts.markLimited('codex-work', 'Codex: Your workspace is out of credits. (workspace_member_credits_depleted)');
  await assert.rejects(agents.startTask({ title: 'Chosen', desc: 'x', agent: 'codex', folder: root, account: 'codex-work' }),
    /^Error: Account codex-work stopped at a usage limit at \d\d:\d\d \(Codex: Your workspace is out of credits\. \(workspace_member_credits_depleted\)\)\. Clear the limit mark on the Accounts page after the limit resets\. Choose another Codex account: codex-default \(Codex \(default\), 0 running, 39% used\)\.$/);
  assert.equal(store.all().length, 0, 'no task was created');
  // resume and move check the account before they start the agent
  const t = store.create({ id: 'on-work-1', num: 1, title: 'On work', agent: 'codex', account: 'codex-work', status: 'suspended', cwd: root, folder: root, session: 'task-1', sessionId: 'thread-1', desc: 'x' });
  assert.throws(() => agents.checkResumeAccount(t), /stopped at a usage limit.*Choose another Codex account: codex-default.*Or move the task to another account\.$/);
  const other = store.create({ id: 'on-default-2', num: 2, title: 'On default', agent: 'codex', account: 'codex-default', status: 'suspended', cwd: root, folder: root, session: 'task-2', sessionId: 'thread-2', desc: 'x' });
  await assert.rejects(agents.moveAccount(other, 'codex-work'), /^Error: Account codex-work stopped at a usage limit.*Choose another Codex account: codex-default/);
  assert.equal(store.get(other.id)!.account, 'codex-default');
  await assert.rejects(agents.takeOver({ ...t, openElsewhere: { pid: 999999, tty: 'ttys999' } }), /stopped at a usage limit/);
  // you clear the mark as before
  accounts.clearLimited('codex-work');
  assert.equal(accounts.unavailable(accounts.get('codex-work')!, 0), undefined);
});

test('typed text does not answer the Codex limit dialogs', () => {
  assert.ok(agents.blockingQuestion.test('  Usage limit reached\n  Request a limit increase from your owner to continue using codex. Request increase?\n› 1. Yes (y)\n  2. No (default) (n)'));
  assert.ok(agents.blockingQuestion.test('  Approaching rate limits\n  Switch to gpt-6-luna for lower credit usage?\n  1. Switch to gpt-6-luna\n› 2. Keep current model'));
});
