import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Codex usage from session files in date folders, without a server. The folders are temporary.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-codex-usage-test-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-codex-usage-test-${process.pid}`;
mkdirSync(join(root, 'state'), { recursive: true });
const dir = join(root, 'home', 'codex');
const H = 3600000, now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
// The stored usage of the account: 100% weekly, read 30 minutes ago
writeFileSync(join(root, 'state', 'accounts.json'), JSON.stringify([
  { id: 'codex-default', agent: 'codex', name: 'Codex (default)', dir, isDefault: true, maxParallel: 8, created: iso(now),
    usage: { windows: [{ label: 'weekly', usedPct: 100, resetsAt: now + 86400000 }], at: iso(now - 0.5 * H), source: 'Codex session file' } },
]));
writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ name: 'codex-usage-test', controller: { autostart: false, remoteControl: false } }));
const accounts = await import('../server/accounts.ts');

const event = (atMs: number, pct: number) => JSON.stringify({ timestamp: iso(atMs), type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: pct, window_minutes: 10080, resets_at: Math.round((now + 86400000) / 1000) }, secondary: null, plan_type: 'pro', rate_limit_reached_type: null } } });
// A session file in the date folder of its start, last changed at the time of its newest line
function rollout(day: string, name: string, lines: { at: number; pct: number }[]) {
  const d = join(dir, 'sessions', ...day.split('-')); mkdirSync(d, { recursive: true });
  const f = join(d, `rollout-${name}.jsonl`);
  writeFileSync(f, lines.map(l => event(l.at, l.pct)).join('\n') + '\n');
  const t = Math.max(...lines.map(l => l.at)) / 1000; utimesSync(f, t, t);
}

test('the newest rate_limits event wins, also from a session in an older date folder', () => {
  // Four newer date folders hold sessions that ended at 100%. The session started on 2026-10-05 is still active
  // and reported 0% after the reset.
  rollout('2026-10-07', 'a', [{ at: now - 5 * H, pct: 100 }]);
  rollout('2026-10-08', 'b', [{ at: now - 4 * H, pct: 100 }]);
  rollout('2026-10-09', 'c', [{ at: now - 2 * H, pct: 100 }]);
  rollout('2026-10-10', 'd', [{ at: now - 0.4 * H, pct: 100 }]);
  rollout('2026-10-05', 'active', [{ at: now - 120 * H, pct: 40 }, { at: now - 0.1 * H, pct: 0 }]);
  const a = accounts.get('codex-default')!;
  assert.match(accounts.unavailable(a, 0)!, /at 100% usage/);
  accounts.refreshCodexUsage();
  assert.equal(a.usage!.windows[0].usedPct, 0);
  assert.equal(a.usage!.at, iso(now - 0.1 * H));
  assert.equal(accounts.unavailable(a, 0), undefined);
});

test('a newer 100% report keeps the account full; an older report does not replace newer numbers', () => {
  const a = accounts.get('codex-default')!;
  rollout('2026-10-10', 'e', [{ at: now - 0.05 * H, pct: 100 }]);
  accounts.refreshCodexUsage();
  assert.equal(a.usage!.windows[0].usedPct, 100);
  assert.match(accounts.unavailable(a, 0)!, /at 100% usage/);
  // stored numbers newer than every session file stay
  a.usage = { windows: [{ label: 'weekly', usedPct: 100, resetsAt: now + 86400000 }], at: iso(now), source: 'Codex session file' };
  accounts.refreshCodexUsage();
  assert.equal(a.usage!.at, iso(now));
});

test('the reading stops at the first file changed before the newest event found', () => {
  // the newest file has no rate_limits line; the next one has the newest event
  const d = join(dir, 'sessions', '2026', '10', '10'); const f = join(d, 'rollout-empty.jsonl');
  writeFileSync(f, '{"type":"session_meta"}\n');
  assert.equal(accounts.codexRollouts(dir)[0], f);
  assert.equal(accounts.newestCodexReport(dir)!.at, iso(now - 0.05 * H));
});

test('a start, resume or move reads the session files first, so a limit that reset does not refuse it', () => {
  const a = accounts.get('codex-default')!;
  assert.match(accounts.unavailable(a, 0)!, /at 100% usage/);
  // the 2026-10-05 session reports again after the stored numbers; no 60-second timer ran in between
  rollout('2026-10-05', 'active', [{ at: now - 120 * H, pct: 40 }, { at: now + 1000, pct: 3 }]);
  assert.equal(accounts.refusal(a, 0, () => 0), undefined);
  assert.equal(a.usage!.windows[0].usedPct, 3);
});
