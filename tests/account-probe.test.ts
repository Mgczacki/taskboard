import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Checks of a limit mark (server/account-probe.ts), without a server. The CLIs are fake: each reads the file "mode"
// in its account folder and prints what the real CLI printed for that case. No real account gets a request.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-account-probe-test-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-account-probe-test-${process.pid}`;
process.env.TASKBOARD_PROBE_TIMEOUT_MS = '1500';
process.env.PROBE_TEST_CALLS = join(root, 'calls');
process.env.TASK_ID = 'must-not-reach-the-cli';
mkdirSync(join(root, 'state'), { recursive: true });
const bin = join(root, 'bin'); mkdirSync(bin);
const fake = (name: string, dirVar: string, signIn: string, outputs: Record<string, string>) => {
  writeFileSync(join(bin, name), `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const dir = process.env.${dirVar}, read = f => { try { return fs.readFileSync(path.join(dir, f), 'utf8').trim(); } catch { return ''; } };
const a = process.argv.slice(2);
if (a[0] === 'auth' || a[0] === 'login') { console.log(read('signed-out') ? ${JSON.stringify(signIn.replace('true', 'false').replace('Logged in', 'Not logged in'))} : ${JSON.stringify(signIn)}); process.exit(0); }
fs.appendFileSync(process.env.PROBE_TEST_CALLS, path.basename(dir) + ' task=' + (process.env.TASK_ID || '') + ' cwd=' + process.cwd() + '\\n');
const mode = read('mode') || 'ok', out = ${JSON.stringify(outputs)};
if (mode === 'hang') setTimeout(() => {}, 60000);
else setTimeout(() => { process.stdout.write(out[mode] || ''); process.exit(mode === 'crash' ? 1 : 0); }, mode === 'slow' ? 400 : 0);
`);
  chmodSync(join(bin, name), 0o755);
};
// Claude Code 2.1.293 printed the "ok" line for a one-word request (7 October 2026). The "limit" line is the text of
// the mark on Claude default as a result without output tokens: the real output for a limit was not observed.
fake('claude', 'CLAUDE_CONFIG_DIR', '{"loggedIn":true}', {
  ok: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK', total_cost_usd: 0.0001304, usage: { input_tokens: 2, output_tokens: 4 } }) + '\n',
  slow: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 2, output_tokens: 4 } }) + '\n',
  limit: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: "You've hit your weekly limit · resets Oct 7 at 5am (America/New_York)", usage: { input_tokens: 0, output_tokens: 0 } }) + '\n',
  crash: '',
});
// Codex 0.160.0 printed the "ok" lines (7 October 2026). The "credit" lines use the error text of task 163.
fake('codex', 'CODEX_HOME', 'Logged in using ChatGPT', {
  ok: ['{"type":"thread.started","thread_id":"t"}', '{"type":"turn.started"}', '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}', '{"type":"turn.completed","usage":{"input_tokens":17467,"output_tokens":5}}'].join('\n') + '\n',
  credit: ['{"type":"thread.started","thread_id":"t"}', '{"type":"turn.started"}', '{"type":"error","message":"Your workspace is out of credits. Ask your workspace owner to refill in order to continue."}', '{"type":"turn.failed","error":{"message":"Your workspace is out of credits. Ask your workspace owner to refill in order to continue."}}'].join('\n') + '\n',
});
process.env.PATH = `${bin}:${process.env.PATH}`;

const now = new Date().toISOString();
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600000).toISOString();
const dir = (id: string) => join(root, 'home', id);
const ids = ['claude-work', 'claude-other', 'codex-work', 'codex-other'];
for (const id of ids) mkdirSync(dir(id), { recursive: true });
writeFileSync(join(root, 'state', 'accounts.json'), JSON.stringify([
  ...ids.map(id => ({ id, agent: id.split('-')[0], name: id, dir: dir(id), maxParallel: 8, created: now })),
  // the defaults keep a fixture mark for the whole file, so pick() never chooses them
  { id: 'claude-default', agent: 'claude', name: 'Claude Code (default)', dir: dir('claude'), isDefault: true, maxParallel: 8, created: now },
  { id: 'codex-default', agent: 'codex', name: 'Codex (default)', dir: dir('codex'), isDefault: true, maxParallel: 8, created: now },
  { id: 'antigravity-default', agent: 'antigravity', name: 'Antigravity (default)', dir: dir('agy'), isDefault: true, maxParallel: 8, created: now },
]));
writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ name: 'account-probe-test', controller: { autostart: false, remoteControl: false } }));

const accounts = await import('../server/accounts.ts');
const probe = await import('../server/account-probe.ts');
const machine = await import('../server/machine.ts');
const P = accounts.PROBE;
const calls = () => existsSync(process.env.PROBE_TEST_CALLS!) ? readFileSync(process.env.PROBE_TEST_CALLS!, 'utf8').trim().split('\n').filter(Boolean) : [];
const mode = (id: string, m: string) => writeFileSync(join(dir(id), 'mode'), m);
const none = () => 0;
// one marked account per test; every other account has no mark, and the defaults are full, so no tick reaches them
function only(id: string, limited: { at: string; note: string }, usage?: unknown) {
  for (const a of accounts.all()) { delete a.limited; delete a.probe; delete a.usage; delete a.limitClearedAt; }
  for (const a of accounts.all().filter(x => x.isDefault)) a.maxParallel = 0;
  const a = accounts.get(id)!; a.limited = limited; a.usage = usage as typeof a.usage; mode(id, 'ok');
  return a;
}
const weekly = (resetsAt: number, at = hoursAgo(40)) => ({ windows: [{ label: 'weekly', usedPct: 100, resetsAt }], at, source: 'Claude Code status line' });

test('a weekly-limit mark is checked only after the reset time, and an accepted request clears it for routing', async () => {
  const reset = Date.now() + 3600000;
  const a = only('claude-work', { at: hoursAgo(50), note: "You've hit your weekly limit · resets Oct 7 at 5am (America/New_York) (on #262)" }, weekly(reset));
  // before the reset: no request, and the account takes no task
  assert.equal(accounts.nextProbeAt(a), reset + P.resetMarginMs);
  assert.equal(await probe.tick(), undefined);
  assert.equal(calls().length, 0);
  assert.equal((await accounts.pick('claude', none)).account.id, 'claude-other');
  // after the reset: the mark and the old 100% are still stored, and the account still takes no task
  a.usage!.windows[0].resetsAt = Date.now() - 6 * 60000;
  assert.match(accounts.unavailable(a, 0)!, /stopped at a usage limit .* Taskboard checks the account again at about \d\d:\d\d/);
  assert.equal(await probe.tick(), 'claude-work');
  assert.equal(calls().length, 1);
  // the request ran in the folder of the checks, on that account, without the variables of a task
  assert.match(calls()[0], /^claude-work task= cwd=.*\/ask\/account-probe$/);
  assert.equal(a.limited, undefined);
  assert.equal(a.probe!.result, 'accepted'); assert.equal(a.probe!.failures, 0);
  assert.ok(Date.now() - Date.parse(a.probe!.at) < 5000);
  assert.equal(accounts.unavailable(a, 0), undefined);
  // routing uses the new state: with the other account busy, pick() chooses the checked account
  assert.equal((await accounts.pick('claude', id => id === 'claude-other' ? 3 : 0)).account.id, 'claude-work');
  // the saved file has the result, so a restart of the server keeps it
  const saved = JSON.parse(readFileSync(join(root, 'state', 'accounts.json'), 'utf8')).find((x: { id: string }) => x.id === 'claude-work');
  assert.equal(saved.probe.result, 'accepted'); assert.equal(saved.limited, undefined);
});

test('stale usage, a passed reset time and a sign-in do not clear a mark without a request', async () => {
  const a = only('claude-work', { at: hoursAgo(50), note: 'weekly limit' }, weekly(Date.now() - 3600000));
  machine.get().accounts.probeLimited = false; // the automatic checks are off
  try {
    assert.equal(accounts.usageStale(a), true);
    assert.equal(accounts.fullUntil(a), 0);
    assert.equal((await accounts.status(a)).signedIn, true);
    const before = calls().length;
    assert.equal(await probe.tick(), undefined);
    assert.equal(calls().length, before);
    assert.ok(a.limited);
    assert.match(accounts.unavailable(a, 0)!, /After the limit resets, clear the limit mark on the Accounts page\.$/);
    assert.equal((await accounts.pick('claude', none)).account.id, 'claude-other');
  } finally { delete machine.get().accounts.probeLimited; }
});

test('a mark for no credit stays while the provider refuses the request, and the wait doubles', async () => {
  // Work Codex: marked on 2 October, weekly window reset since then; the reset does not prove that credit is back
  const note = 'Codex: Your workspace is out of credits. Ask your workspace owner to refill in order to continue. (workspace_member_credits_depleted)';
  const a = only('codex-work', { at: hoursAgo(1), note }, { windows: [{ label: 'weekly', usedPct: 97, resetsAt: Date.now() - 86400000 }], at: hoursAgo(170), source: 'Codex session file', plan: 'team' });
  mode('codex-work', 'credit');
  // the first check of a credit mark waits 6 hours
  assert.equal(accounts.creditMark(a), true);
  assert.equal(accounts.nextProbeAt(a), Date.parse(a.limited!.at) + P.creditBaseMs);
  let before = calls().length;
  assert.equal(await probe.tick(), undefined);
  assert.equal(calls().length, before);
  a.limited!.at = hoursAgo(130);
  assert.equal(await probe.tick(), 'codex-work');
  assert.equal(calls().length, before + 1);
  assert.equal(a.probe!.result, 'rejected'); assert.equal(a.probe!.failures, 1);
  assert.match(a.probe!.note, /Your workspace is out of credits/);
  assert.equal(a.limited!.note, note); assert.equal(a.limited!.at, hoursAgo(130).slice(0, 13) + a.limited!.at.slice(13));
  assert.equal(accounts.nextProbeAt(a), Date.parse(a.probe!.at) + P.creditBaseMs);
  assert.equal((await accounts.pick('codex', none)).account.id, 'codex-other');
  assert.match(accounts.usageSummary(none), /codex-work .* limited \(Codex: Your workspace is out of credits.*; check at [\d\-T:]+Z: rejected\)/);
  // ticks right after a refused request send nothing: no loop
  before = calls().length;
  for (let i = 0; i < 3; i++) assert.equal(await probe.tick(), undefined);
  assert.equal(calls().length, before);
  // 6 hours later the second check runs; after it the wait is 12 hours, and it never goes above 24 hours
  a.probe!.at = hoursAgo(6.1);
  assert.equal(await probe.tick(), 'codex-work');
  assert.equal(a.probe!.failures, 2);
  assert.equal(accounts.nextProbeAt(a), Date.parse(a.probe!.at) + 2 * P.creditBaseMs);
  a.probe!.failures = 9;
  assert.equal(accounts.nextProbeAt(a), Date.parse(a.probe!.at) + P.creditMaxMs);
  // the workspace has credit again: the next check clears the mark
  mode('codex-work', 'ok'); a.probe!.at = hoursAgo(25);
  assert.equal(await probe.tick(), 'codex-work');
  assert.equal(a.limited, undefined); assert.equal(a.probe!.result, 'accepted');
  assert.equal((await accounts.pick('codex', id => id === 'codex-other' ? 2 : 0)).account.id, 'codex-work');
});

test('a request with no answer keeps the mark: timeout, CLI error, limit text as the reply, no sign-in', async () => {
  const a = only('claude-work', { at: hoursAgo(3), note: 'weekly limit' });
  mode('claude-work', 'hang');
  const t0 = Date.now();
  let p = await probe.probe('claude-work');
  assert.equal(p.result, 'failed'); assert.match(p.note, /No answer in 2 seconds/);
  assert.ok(Date.now() - t0 < 8000, 'the request is stopped at its time limit');
  assert.ok(a.limited); assert.equal(a.probe!.failures, 1);
  // a usage-limit mark: 1 hour after the first failed check, 2 hours after the second
  assert.equal(accounts.nextProbeAt(a), Date.parse(a.probe!.at) + P.limitBaseMs);
  mode('claude-work', 'crash');
  p = await probe.probe('claude-work');
  assert.equal(p.result, 'failed'); assert.equal(p.failures, 2); assert.ok(a.limited);
  assert.equal(accounts.nextProbeAt(a), Date.parse(a.probe!.at) + 2 * P.limitBaseMs);
  // Claude Code prints the limit text as a result that is not marked as an error: it is not a reply from a model
  mode('claude-work', 'limit');
  p = await probe.probe('claude-work');
  assert.equal(p.result, 'rejected'); assert.match(p.note, /hit your weekly limit/); assert.ok(a.limited);
  // signed out: no request is sent, and the mark stays
  writeFileSync(join(dir('claude-work'), 'signed-out'), '1'); mode('claude-work', 'ok');
  const before = calls().length;
  p = await probe.probe('claude-work');
  rmSync(join(dir('claude-work'), 'signed-out'));
  assert.equal(p.result, 'failed'); assert.match(p.note, /not signed in, so no request was sent/);
  assert.equal(calls().length, before); assert.ok(a.limited);
  await accounts.status(a, true);
});

test('a usage-limit mark without a reset time is first checked 30 minutes after the mark', async () => {
  const a = only('claude-work', { at: new Date(Date.now() - 10 * 60000).toISOString(), note: 'API Error: rate limit (on #5)' });
  assert.equal(accounts.nextProbeAt(a), Date.parse(a.limited!.at) + P.limitFirstMs);
  const before = calls().length;
  assert.equal(await probe.tick(), undefined);
  assert.equal(calls().length, before);
  a.limited!.at = new Date(Date.now() - 31 * 60000).toISOString();
  assert.equal(await probe.tick(), 'claude-work');
  assert.equal(a.limited, undefined);
  // The mark comes back 10 minutes after that check cleared it: the check did not prove that tasks work, so the
  // first check of the new mark waits 6 hours.
  a.probe!.at = new Date(Date.now() - 50 * 60000).toISOString();
  a.limited = { at: new Date(Date.now() - 40 * 60000).toISOString(), note: 'weekly limit for one model' };
  assert.equal(accounts.nextProbeAt(a), Date.parse(a.limited.at) + P.creditBaseMs);
  assert.equal(await probe.tick(), undefined);
});

test('a mark that a task sets while the request runs stays, and "Check now" has a minimum gap', async () => {
  const a = only('claude-work', { at: hoursAgo(3), note: 'weekly limit' });
  mode('claude-work', 'slow');
  const run = probe.probe('claude-work', true);
  await new Promise(r => setTimeout(r, 150));
  // only one check runs at a time on the machine
  await assert.rejects(probe.probe('claude-work', true), /A check of claude-work runs now/);
  a.limited = { at: new Date().toISOString(), note: 'new limit (on #9)' };
  const p = await run;
  assert.equal(p.result, 'accepted'); assert.equal(p.manual, true);
  assert.equal(a.limited!.note, 'new limit (on #9)');
  await assert.rejects(probe.probe('claude-work', true), /was checked 1 min ago\. Wait 10 minutes between checks/);
  delete a.limited;
  await assert.rejects(probe.probe('claude-work', true), /has no limit mark/);
});

test('the output of each CLI is accepted only with its success field and the word OK', () => {
  const c = probe.classify;
  assert.equal(c('claude', '{"type":"result","subtype":"success","is_error":false,"result":"OK","usage":{"output_tokens":4}}', '', 0).result, 'accepted');
  assert.equal(c('claude', '{"type":"result","subtype":"success","is_error":true,"result":"API Error: Credit balance is too low","usage":{"output_tokens":0}}', '', 1).result, 'rejected');
  assert.equal(c('claude', '{"type":"result","subtype":"error_max_budget_usd","is_error":true,"usage":{"output_tokens":0}}', '', 1).result, 'failed');
  assert.deepEqual(c('claude', '', 'OAuth token has expired. Please run /login', 1), { result: 'failed', note: 'The account is not signed in: OAuth token has expired. Please run /login' });
  assert.equal(c('claude', 'OK', '', 0).result, 'failed'); // text without the result record
  assert.equal(c('codex', '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}\n{"type":"turn.completed","usage":{}}', '', 0).result, 'accepted');
  assert.equal(c('codex', '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}', '', 0).result, 'failed'); // no completed turn
  assert.equal(c('codex', '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit. Try again at 5:00 PM."}}', '', 1).result, 'rejected');
  assert.equal(c('codex', '{"type":"error","message":"stream disconnected before completion"}', '', 1).result, 'failed');
  // agy printed this line for a one-word request on 7 October 2026
  assert.equal(c('antigravity', '{"conversation_id":"c","status":"SUCCESS","response":"OK\\n","num_turns":1}', '', 0).result, 'accepted');
  assert.equal(c('antigravity', '', 'generating and executing: RESOURCE_EXHAUSTED (code 429): Individual quota reached.', 1).result, 'rejected');
  assert.equal(c('antigravity', '{"status":"ERROR","response":""}', '', 1).result, 'failed');
});

test.after(() => rmSync(root, { recursive: true, force: true }));
