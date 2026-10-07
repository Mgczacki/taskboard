// Accounts: each account is a settings folder (CLAUDE_CONFIG_DIR for Claude Code, CODEX_HOME for Codex), so several
// accounts run side by side and each task uses one. The CLIs log in themselves; Taskboard never reads credential files,
// it only asks `claude auth status` / `codex login status` / `agy models`.
import { execFile } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { AGY_HOME, HOME, TB_DIR, agyBin } from './config.ts';
import * as machine from './machine.ts';
import { createProfile, prepareProfile } from './agy-profile.ts';

const exec = promisify(execFile);
export type AgentKind = 'claude' | 'codex' | 'antigravity';
export interface Account {
  id: string; agent: AgentKind; name: string; dir: string; isDefault?: boolean; maxParallel: number;
  routingRules?: string;
  limited?: { at: string; note: string };   // hit a usage limit or ran out of credit; cleared when a turn on it succeeds or a check is accepted
  limitClearedAt?: string;                    // when the mark was last cleared: older limit reports do not set it again
  probe?: Probe;                              // the last small request that server/account-probe.ts sent to check the mark
  usage?: Usage;                              // latest usage windows reported for this account
  created: string;
}
// The last check of a limit mark (server/account-probe.ts). accepted: a model answered, so the mark was cleared.
// rejected: the provider refused the request with a limit or credit error, so the mark stays. failed: no answer that
// proves either (a timeout, a CLI error, an account that is not signed in), so the mark stays. failures counts the
// checks in a row that did not end in accepted; the wait before the next check doubles with it.
export type ProbeResult = 'accepted' | 'rejected' | 'failed';
export interface Probe { at: string; result: ProbeResult; note: string; ms: number; failures: number; manual?: boolean }
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
  { id: 'antigravity-default', agent: 'antigravity', name: 'Antigravity (default)', dir: AGY_HOME, isDefault: true, maxParallel: 8, created: new Date(0).toISOString() },
];
for (const d of defaults) if (!accounts.some(a => a.id === d.id)) accounts.push(d);
const save = () => { writeFileSync(FILE, JSON.stringify(accounts, null, 2)); emit(); };

export const all = () => accounts;
export const get = (id?: string) => accounts.find(a => a.id === id);
export const defaultFor = (agent: AgentKind) => accounts.find(a => a.agent === agent && a.isDefault)!;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'account';

export const agyHome = (a: Account) => a.isDefault ? HOME : a.dir;
export const agyConfigDir = (a: Account) => a.isDefault ? a.dir : join(a.dir, '.gemini', 'antigravity-cli');
export async function prepare(a: Account) { if (a.agent === 'antigravity' && !a.isDefault) await prepareProfile(a.dir); }

export async function create(agent: AgentKind, name: string): Promise<Account> {
  const base = `${agent}-${slug(name)}`; let id = base, n = 2;
  const dirFor = (candidate: string) => join(HOME, (agent === 'claude' ? '.claude-' : agent === 'codex' ? '.codex-' : '.agy-') + candidate.replace(/^(claude|codex|antigravity)-/, ''));
  while (accounts.some(a => a.id === id) || (agent === 'antigravity' && existsSync(dirFor(id)))) id = `${base}-${n++}`;
  const dir = dirFor(id);
  mkdirSync(dir, { recursive: true, mode: agent === 'antigravity' ? 0o700 : undefined });
  if (agent === 'antigravity') await createProfile(dir);
  const a: Account = { id, agent, name, dir, maxParallel: machine.get().accounts.defaultMaxParallel, created: new Date().toISOString() };
  accounts.push(a); save(); return a;
}
export function remove(id: string) { const a = get(id); if (!a || a.isDefault) throw new Error('The default accounts cannot be removed.'); accounts = accounts.filter(x => x.id !== id); save(); }
export function update(id: string, patch: Partial<Pick<Account, 'name' | 'maxParallel' | 'routingRules'>>) {
  const a = get(id); if (!a) return;
  if (patch.name !== undefined) a.name = String(patch.name).trim().slice(0, 80);
  if (patch.maxParallel !== undefined) a.maxParallel = machine.checkMaxParallel(patch.maxParallel);
  if (patch.routingRules !== undefined) a.routingRules = String(patch.routingRules).trim().slice(0, 500);
  save(); return a;
}

// Set every account's maximum to n. Running tasks keep running; only new starts check the maximum.
export function setAllMaxParallel(n: number) { const max = machine.checkMaxParallel(n); for (const a of accounts) a.maxParallel = max; save(); }

// Environment that points a CLI at an account's folder (nothing for the default folders).
export function envFor(a?: Account): Record<string, string> {
  if (!a || a.isDefault) return {};
  return a.agent === 'claude' ? { CLAUDE_CONFIG_DIR: a.dir } : a.agent === 'codex' ? { CODEX_HOME: a.dir } : { HOME: a.dir };
}

const statusCache = new Map<string, AccountStatus>();
const statusChecks = new Map<string, Promise<AccountStatus>>();
const statusVersion = new Map<string, number>();
export async function status(a: Account, fresh = false): Promise<AccountStatus> {
  if (fresh) statusCache.delete(a.id);
  const c = statusCache.get(a.id); if (c && !fresh && Date.now() - c.checkedAt < 60000) return c;
  const running = statusChecks.get(a.id); if (running && !fresh) return running;
  const version = (statusVersion.get(a.id) || 0) + 1;
  statusVersion.set(a.id, version);
  const check = checkStatus(a).then(s => {
    if (statusVersion.get(a.id) === version) statusCache.set(a.id, s);
    return s;
  });
  statusChecks.set(a.id, check);
  try { return await check; } finally { if (statusChecks.get(a.id) === check) statusChecks.delete(a.id); }
}

async function checkStatus(a: Account): Promise<AccountStatus> {
  let s: AccountStatus = { signedIn: false, checkedAt: Date.now() };
  try {
    const env = { ...process.env, ...envFor(a) };
    if (a.agent === 'claude') {
      const { stdout } = await exec('claude', ['auth', 'status'], { env, timeout: 15000 });
      const j = JSON.parse(stdout); s = { signedIn: !!j.loggedIn, who: j.email || j.orgName || j.authMethod, checkedAt: Date.now() };
    } else if (a.agent === 'antigravity') {
      await prepare(a);
      // `agy models` lists the models when signed in; otherwise it prints "Please sign in to view available models."
      const { stdout, stderr } = await exec(agyBin(), ['models'], { env, timeout: 20000 }).catch(e => ({ stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }));
      const out = stdout + stderr; const n = out.split('\n').filter(l => l.includes('\t')).length;
      s = { signedIn: n > 0 && !/sign in/i.test(out), who: n > 0 ? `${n} models available` : undefined, checkedAt: Date.now() };
    } else {
      mkdirSync(a.dir, { recursive: true });
      const { stdout, stderr } = await exec('codex', ['login', 'status'], { env, timeout: 15000 }).catch(e => ({ stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }));
      const out = (stdout + stderr).trim(); s = { signedIn: /logged in/i.test(out) && !/not logged in/i.test(out), who: out.split('\n')[0], checkedAt: Date.now() };
    }
  } catch (e) { if (a.agent === 'antigravity' && !a.isDefault) s.who = (e as Error).message; }
  return s;
}

export function markLimited(id: string | undefined, note: string) { const a = get(id); if (a && !a.limited) { a.limited = { at: new Date().toISOString(), note }; save(); } }
export function clearLimited(id: string | undefined) { const a = get(id); if (a?.limited) { delete a.limited; a.limitClearedAt = new Date().toISOString(); save(); } }
// A limit report from `at` (an ISO time) still applies: it is newer than the last time the mark was cleared.
export const reportApplies = (a: Account, at: string) => !a.limitClearedAt || Date.parse(at) > Date.parse(a.limitClearedAt);
// The Codex error text for a rate_limit_reached_type in a session file (Codex 0.160.0 writes
// "workspace_member_credits_depleted" with primary and secondary null when a workspace has no credits left).
export const codexLimitNote = (type: string, message?: string) =>
  `Codex: ${message || (/credits?_depleted|credits/.test(type) ? 'the workspace is out of credits' : 'usage limit reached')} (${type})`;

export function setProbe(id: string | undefined, p: Probe) { const a = get(id); if (a) { a.probe = p; save(); } }
// A mark for no credit or a billing problem. No usage window says when such a mark ends.
export const creditMark = (a: Account) => /credit|billing|balance|payment/i.test(a.limited?.note || '');
// The waits between checks of a limit mark. A usage limit: first 30 minutes after the mark, then 1 hour, doubled after
// each check that did not clear the mark, up to 12 hours. No credit: first after 6 hours, then doubled up to 24 hours.
// A window at 100% is not checked before its reset time plus 5 minutes.
export const PROBE = { limitFirstMs: 30 * 60000, limitBaseMs: 3600000, limitMaxMs: 12 * 3600000, creditBaseMs: 6 * 3600000, creditMaxMs: 24 * 3600000, resetMarginMs: 5 * 60000, disprovedMs: 2 * 3600000 };
// The earliest time for the next check of this account's limit mark, in ms; undefined when it has no mark.
export function nextProbeAt(a: Account): number | undefined {
  if (!a.limited) return;
  const marked = Date.parse(a.limited.at) || 0, credit = creditMark(a), p = a.probe, probed = p ? Date.parse(p.at) || 0 : 0;
  const until = fullUntil(a), afterReset = until ? until + PROBE.resetMarginMs : 0;
  const base = credit ? PROBE.creditBaseMs : PROBE.limitBaseMs, max = credit ? PROBE.creditMaxMs : PROBE.limitMaxMs;
  // a check of this mark already ran: wait base, 2 x base, 4 x base ... after it
  if (p && probed >= marked && p.result !== 'accepted') return Math.max(probed + Math.min(max, base * 2 ** Math.max(0, p.failures - 1)), afterReset);
  // The mark came back less than 2 hours after a check cleared it: that check did not prove that tasks work (for
  // example a limit for one model only), so the first check of the new mark waits as long as a credit mark.
  const disproved = !!p && p.result === 'accepted' && marked > probed && marked - probed < PROBE.disprovedMs;
  return Math.max(marked + (credit || disproved ? PROBE.creditBaseMs : PROBE.limitFirstMs), afterReset);
}
export const probeEnabled = () => machine.get().accounts.probeLimited !== false;

export function setUsage(id: string | undefined, u: Usage) {
  const a = get(id); if (!a) return;
  const same = a.usage && JSON.stringify(a.usage.windows) === JSON.stringify(u.windows);
  a.usage = u;
  if (!same) save(); // only write the file when a number changed
}
// Usage data older than this is unknown: the account may have used its limits or its credit since then. Codex writes
// new numbers only in a turn that the server accepts, so an account without credit keeps its last numbers for days.
export const USAGE_STALE_MS = 6 * 3600 * 1000;
export const usageAge = (a: Account) => a.usage ? Date.now() - (Date.parse(a.usage.at) || 0) : undefined;
export const usageStale = (a: Account) => !a.usage || usageAge(a)! > USAGE_STALE_MS;
// "43 h", "25 min": how old the usage data is
export const ageText = (ms: number) => ms >= 3600000 ? `${Math.round(ms / 3600000)} h` : `${Math.max(1, Math.round(ms / 60000))} min`;
// A window at 100% that has not reset yet means the account cannot be used until then (also from old data: the
// used share of a window does not go down before it resets).
export const fullUntil = (a: Account) => {
  const w = a.usage?.windows.filter(x => x.usedPct >= 100 && (!x.resetsAt || x.resetsAt > Date.now())) || [];
  return w.length ? Math.max(...w.map(x => x.resetsAt || 0)) : 0;
};
// "14:05" today, "Wed 30 Sep 14:05" on another day (server local time)
const clock = (ms: number) => new Date(ms).toDateString() === new Date().toDateString()
  ? new Date(ms).toTimeString().slice(0, 5)
  : new Date(ms).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).replace(',', '');
// Why the account cannot take one more task, or undefined when it can. `running` is its number of running tasks.
// The same text goes to the dashboard, tb and the controller.
export function unavailable(a: Account, running: number): string | undefined {
  const until = fullUntil(a);
  if (until) return `Account ${a.id} is at 100% usage until ${clock(until)}.`;
  if (a.limited) return `Account ${a.id} stopped at a usage limit at ${clock(Date.parse(a.limited.at))} (${a.limited.note}). ${probeEnabled() ? `Taskboard checks the account again at about ${clock(Math.max(nextProbeAt(a)!, Date.now()))} and clears the mark when the provider accepts a request. You can also` : 'After the limit resets,'} clear the limit mark on the Accounts page.`;
  if (running >= a.maxParallel) return `Account ${a.id} is at its limit of ${a.maxParallel} tasks (raise it on the Accounts page).`;
}
// The highest used share of the open windows, or undefined when the data is missing or stale (unknown, not free).
const peak = (a: Account) => usageStale(a) ? undefined : Math.max(0, ...(a.usage?.windows || []).filter(w => !w.resetsAt || w.resetsAt > Date.now()).map(w => w.usedPct));
const usageNote = (a: Account) => { const p = peak(a); return p !== undefined ? `${p}% used` : a.usage ? `usage unknown, data ${ageText(usageAge(a)!)} old` : 'usage unknown'; };

// Other accounts of the same agent that can take a task now, for a refusal message. Sign-in comes from the cached
// status (a check that has not run yet counts as signed in; the start checks it again).
export function alternatives(a: Account, running: (id: string) => number): string {
  const ok = accounts.filter(x => x.agent === a.agent && x.id !== a.id && !unavailable(x, running(x.id)) && statusCache.get(x.id)?.signedIn !== false);
  const agentLabel = a.agent === 'claude' ? 'Claude Code' : a.agent === 'codex' ? 'Codex' : 'Antigravity';
  return ok.length
    ? ` Choose another ${agentLabel} account: ${ok.map(x => `${x.id} (${x.name}, ${running(x.id)} running, ${usageNote(x)})`).join('; ')}.`
    : ` No other ${agentLabel} account is available now.`;
}
// Why a task cannot start on this account, with the accounts it can use instead; undefined when it can start.
export function refusal(a: Account, running: number, runningOf: (id: string) => number): string | undefined {
  const why = unavailable(a, running);
  return why && why + alternatives(a, runningOf);
}

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
      let error: string | undefined; // the message of a turn that failed after the newest rate_limits line
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"rate_limits"') && !lines[i].includes('"task_complete"')) continue;
        let o: any; try { o = JSON.parse(lines[i]); } catch { continue; }
        if (o.payload?.type === 'task_complete') { error ??= o.payload.error?.message; continue; }
        const rl = o.payload?.rate_limits ?? o.payload?.info?.rate_limits; if (!rl) continue;
        // No credit or a reached limit: Codex writes the reason and no windows. Mark the account; keep the old numbers,
        // whose age then shows that they are stale.
        if (rl.rate_limit_reached_type) {
          const at = o.timestamp || new Date(statSync(f).mtimeMs).toISOString();
          if (reportApplies(a, at)) markLimited(a.id, codexLimitNote(rl.rate_limit_reached_type, error));
          break;
        }
        if (!rl.primary) continue;
        // a later turn that the server accepted: the account works again
        if (a.limited && o.timestamp && Date.parse(o.timestamp) > Date.parse(a.limited.at)) clearLimited(a.id);
        const windows = [rl.primary, rl.secondary].filter(Boolean).map((w: any) => ({ label: windowLabel(w.window_minutes), usedPct: Math.round(w.used_percent), resetsAt: w.resets_at ? w.resets_at * 1000 : undefined }));
        setUsage(a.id, { windows, at: o.timestamp || new Date(statSync(f).mtimeMs).toISOString(), source: 'Codex session file', plan: rl.plan_type || undefined });
        break;
      }
    } catch { /* unreadable folder */ }
  }
}

// Automatic choice: the signed-in account of that agent with the fewest running tasks, skipping limited and full ones.
export async function pick(agent: AgentKind, running: (id: string) => number, exclude: string[] = []): Promise<{ account: Account; why: string }> {
  const cands = accounts.filter(a => a.agent === agent && !exclude.includes(a.id));
  const skipped: string[] = [], ok: Account[] = [];
  for (const a of cands) {
    const why = unavailable(a, running(a.id));
    if (why) { skipped.push(why.replace(/\.$/, '')); continue; }
    if (!(await status(a)).signedIn) { skipped.push(`${a.name} is not signed in`); continue; }
    ok.push(a);
  }
  if (!ok.length) throw new Error(`No ${agent} account is available (${skipped.join('; ')}).`);
  // fewest running first; then the lowest usage, where unknown or stale usage counts as full; then the default account
  const rank = (a: Account) => peak(a) ?? 100;
  const best = ok.sort((x, y) => running(x.id) - running(y.id) || rank(x) - rank(y) || Number(!!y.isDefault) - Number(!!x.isDefault))[0];
  return { account: best, why: `${best.name} (${running(best.id)} running, ${usageNote(best)})${skipped.length ? ` — skipped: ${skipped.join('; ')}` : ''}` };
}

export function usageSummary(running: (id: string) => number): string {
  refreshCodexUsage();
  const lines = accounts.map(a => {
    const windows = a.usage?.windows.map(w => {
      const reset = w.resetsAt ? `@${new Date(w.resetsAt).toISOString().slice(5, 16)}Z` : '';
      return `${w.label}=${w.resetsAt && w.resetsAt <= Date.now() ? 'reset' : `${w.usedPct}%`}${reset}`;
    }).join(', ') || 'usage unknown';
    const stale = a.usage && usageStale(a) ? ` STALE (${ageText(usageAge(a)!)} old; count as unknown)` : '';
    return `${a.id} (${a.name}; ${a.agent}) ${running(a.id)}/${a.maxParallel} ${a.limited ? `limited (${a.limited.note}${a.probe && Date.parse(a.probe.at) >= Date.parse(a.limited.at) ? `; check at ${a.probe.at.slice(5, 16)}Z: ${a.probe.result}` : ''}) ` : ''}${windows} data=${a.usage?.at.slice(5, 16) || 'unknown'}${stale}`;
  });
  return `[Account usage]\n${lines.join('\n')}`;
}

// Copy a Claude Code session transcript into another account's folder so `claude --resume` finds it there.
export function copyClaudeSession(transcript: string, from: Account, to: Account): string {
  const rel = relative(from.dir, transcript);
  if (rel.startsWith('..')) throw new Error('The transcript is not inside the old account folder.');
  const dest = join(to.dir, rel); mkdirSync(dirname(dest), { recursive: true }); copyFileSync(transcript, dest); return dest;
}
