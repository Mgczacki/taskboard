// Accounts: each account is a settings folder (CLAUDE_CONFIG_DIR for Claude Code, CODEX_HOME for Codex), so several
// accounts run side by side and each task uses one. The CLIs log in themselves; Taskboard never reads credential files,
// it only asks `claude auth status` / `codex login status`.
import { execFile } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { HOME, TB_DIR } from './config.ts';

const exec = promisify(execFile);
export type AgentKind = 'claude' | 'codex';
export interface Account {
  id: string; agent: AgentKind; name: string; dir: string; isDefault?: boolean; maxParallel: number;
  limited?: { at: string; note: string };   // hit a usage limit; cleared when a turn on it succeeds
  usage?: Usage;                              // latest usage windows reported for this account
  created: string;
}
// Usage windows as the CLIs report them: Claude Code passes them to its status line, Codex writes them into its
// session files. usedPct is 0–100; resetsAt is a time in ms.
export interface UsageWindow { label: string; usedPct: number; resetsAt?: number }
export interface Usage { windows: UsageWindow[]; at: string; source: string; plan?: string }
export interface AccountStatus { signedIn: boolean; who?: string; checkedAt: number }

const FILE = join(TB_DIR, 'accounts.json');
const listeners = new Set<() => void>();
export const onAccountsChange = (fn: () => void) => { listeners.add(fn); };
const emit = () => listeners.forEach(f => f());

let accounts: Account[] = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : [];
const defaults: Account[] = [
  { id: 'claude-default', agent: 'claude', name: 'Claude Code (default)', dir: join(HOME, '.claude'), isDefault: true, maxParallel: 8, created: new Date(0).toISOString() },
  { id: 'codex-default', agent: 'codex', name: 'Codex (default)', dir: join(HOME, '.codex'), isDefault: true, maxParallel: 8, created: new Date(0).toISOString() },
];
for (const d of defaults) if (!accounts.some(a => a.id === d.id)) accounts.push(d);
const save = () => { writeFileSync(FILE, JSON.stringify(accounts, null, 2)); emit(); };

export const all = () => accounts;
export const get = (id?: string) => accounts.find(a => a.id === id);
export const defaultFor = (agent: AgentKind) => accounts.find(a => a.agent === agent && a.isDefault)!;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'account';

export function create(agent: AgentKind, name: string): Account {
  const base = `${agent}-${slug(name)}`; let id = base, n = 2;
  while (accounts.some(a => a.id === id)) id = `${base}-${n++}`;
  const dir = join(HOME, (agent === 'claude' ? '.claude-' : '.codex-') + id.replace(/^(claude|codex)-/, ''));
  mkdirSync(dir, { recursive: true });
  const a: Account = { id, agent, name, dir, maxParallel: 4, created: new Date().toISOString() };
  accounts.push(a); save(); return a;
}
export function remove(id: string) { const a = get(id); if (!a || a.isDefault) throw new Error('The default accounts cannot be removed.'); accounts = accounts.filter(x => x.id !== id); save(); }
export function update(id: string, patch: Partial<Pick<Account, 'name' | 'maxParallel'>>) { const a = get(id); if (a) { Object.assign(a, patch); save(); } return a; }

// Environment that points a CLI at an account's folder (nothing for the default folders).
export function envFor(a?: Account): Record<string, string> {
  if (!a || a.isDefault) return {};
  return a.agent === 'claude' ? { CLAUDE_CONFIG_DIR: a.dir } : { CODEX_HOME: a.dir };
}

const statusCache = new Map<string, AccountStatus>();
export async function status(a: Account, fresh = false): Promise<AccountStatus> {
  const c = statusCache.get(a.id); if (c && !fresh && Date.now() - c.checkedAt < 60000) return c;
  let s: AccountStatus = { signedIn: false, checkedAt: Date.now() };
  try {
    const env = { ...process.env, ...envFor(a) };
    if (a.agent === 'claude') {
      const { stdout } = await exec('claude', ['auth', 'status'], { env, timeout: 15000 });
      const j = JSON.parse(stdout); s = { signedIn: !!j.loggedIn, who: j.email || j.orgName || j.authMethod, checkedAt: Date.now() };
    } else {
      mkdirSync(a.dir, { recursive: true });
      const { stdout, stderr } = await exec('codex', ['login', 'status'], { env, timeout: 15000 }).catch(e => ({ stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }));
      const out = (stdout + stderr).trim(); s = { signedIn: /logged in/i.test(out) && !/not logged in/i.test(out), who: out.split('\n')[0], checkedAt: Date.now() };
    }
  } catch { /* CLI missing or failed: not signed in */ }
  statusCache.set(a.id, s); return s;
}

export function markLimited(id: string | undefined, note: string) { const a = get(id); if (a && !a.limited) { a.limited = { at: new Date().toISOString(), note }; save(); } }
export function clearLimited(id: string | undefined) { const a = get(id); if (a?.limited) { delete a.limited; save(); } }

export function setUsage(id: string | undefined, u: Usage) {
  const a = get(id); if (!a) return;
  const same = a.usage && JSON.stringify(a.usage.windows) === JSON.stringify(u.windows);
  a.usage = u;
  if (!same) save(); // only write the file when a number changed
}
// A window at 100% that has not reset yet means the account cannot be used until then.
export const fullUntil = (a: Account) => {
  const w = a.usage?.windows.filter(x => x.usedPct >= 100 && (!x.resetsAt || x.resetsAt > Date.now())) || [];
  return w.length ? Math.max(...w.map(x => x.resetsAt || 0)) : 0;
};
const peak = (a: Account) => Math.max(0, ...(a.usage?.windows || []).filter(w => !w.resetsAt || w.resetsAt > Date.now()).map(w => w.usedPct));

// Codex writes its current limits into every session file ("token_count" events with rate_limits). Read the newest.
const windowLabel = (min?: number) => !min ? 'window' : min === 300 ? '5-hour' : min === 10080 ? 'weekly' : min % 1440 === 0 ? `${min / 1440}-day` : `${Math.round(min / 60)}-hour`;
function newestRollout(dir: string): string | undefined {
  const root = join(dir, 'sessions'); if (!existsSync(root)) return;
  const sub = (p: string) => { try { return readdirSync(p).filter(n => /^\d+$/.test(n)).sort().reverse(); } catch { return []; } };
  const days: string[] = [];
  for (const y of sub(root)) for (const m of sub(join(root, y))) for (const d of sub(join(root, y, m))) { days.push(join(root, y, m, d)); if (days.length >= 3) break; }
  let best: { p: string; t: number } | undefined;
  for (const d of days) for (const f of readdirSync(d)) if (f.endsWith('.jsonl')) { const p = join(d, f), t = statSync(p).mtimeMs; if (!best || t > best.t) best = { p, t }; }
  return best?.p;
}
export function refreshCodexUsage() {
  for (const a of accounts.filter(x => x.agent === 'codex')) {
    try {
      const f = newestRollout(a.dir); if (!f) continue;
      const size = statSync(f).size, start = Math.max(0, size - 524288), buf = Buffer.alloc(size - start);
      const fd = openSync(f, 'r'); try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"rate_limits"')) continue;
        let o: any; try { o = JSON.parse(lines[i]); } catch { continue; }
        const rl = o.payload?.rate_limits ?? o.payload?.info?.rate_limits; if (!rl?.primary) continue;
        const windows = [rl.primary, rl.secondary].filter(Boolean).map((w: any) => ({ label: windowLabel(w.window_minutes), usedPct: Math.round(w.used_percent), resetsAt: w.resets_at ? w.resets_at * 1000 : undefined }));
        setUsage(a.id, { windows, at: o.timestamp || new Date(statSync(f).mtimeMs).toISOString(), source: 'Codex session file', plan: rl.plan_type || undefined });
        break;
      }
    } catch { /* unreadable folder */ }
  }
}

// Automatic choice: the signed-in account of that agent with the fewest running tasks, skipping limited and full ones.
export async function pick(agent: AgentKind, running: (id: string) => number): Promise<{ account: Account; why: string }> {
  const cands = accounts.filter(a => a.agent === agent);
  const skipped: string[] = [], ok: Account[] = [];
  for (const a of cands) {
    if (a.limited) { skipped.push(`${a.name} is at its limit`); continue; }
    const until = fullUntil(a);
    if (until) { skipped.push(`${a.name} is at 100% until ${new Date(until).toTimeString().slice(0, 5)}`); continue; }
    if (running(a.id) >= a.maxParallel) { skipped.push(`${a.name} already runs ${a.maxParallel} tasks`); continue; }
    if (!(await status(a)).signedIn) { skipped.push(`${a.name} is not signed in`); continue; }
    ok.push(a);
  }
  if (!ok.length) return { account: defaultFor(agent), why: `No account available (${skipped.join('; ')}); using the default.` };
  // fewest running first; then the lowest usage; then the default account
  const best = ok.sort((x, y) => running(x.id) - running(y.id) || peak(x) - peak(y) || Number(!!y.isDefault) - Number(!!x.isDefault))[0];
  return { account: best, why: `${best.name} (${running(best.id)} running${best.usage ? `, ${peak(best)}% used` : ''})${skipped.length ? ` — skipped: ${skipped.join('; ')}` : ''}` };
}

// Copy a Claude Code session transcript into another account's folder so `claude --resume` finds it there.
export function copyClaudeSession(transcript: string, from: Account, to: Account): string {
  const rel = relative(from.dir, transcript);
  if (rel.startsWith('..')) throw new Error('The transcript is not inside the old account folder.');
  const dest = join(to.dir, rel); mkdirSync(dirname(dest), { recursive: true }); copyFileSync(transcript, dest); return dest;
}
