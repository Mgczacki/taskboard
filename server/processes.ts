// Process counts for Taskboard and each task, with CPU, memory, threads, energy impact and age.
// (GET /api/processes, `tb top`, Settings → Processes).
//
// Who owns a process, in this order (the first rule that matches wins):
//  1. a task browser whose recorded PID and start time match its profile lock, and all its children.
//  2. a tmux pane of Taskboard's socket: the session of a task (task.session) or of its `tb run` processes
//     (proc-<task number>), and every process below that pane (the agent, its shells, MCP servers, test servers).
//  3. a tmux client or pipe-pane belongs to Taskboard unless a caller supplies its task relation.
//  4. the tmux server itself and its other children: Taskboard. This comes before rule 5 because the tmux server can
//     carry the TASK_ID of the session that started it (observed: TASK_ID=controller).
//  5. a process that left the tree stays unowned. The live reader never scans process environments.
//  6. the server process and its launcher (Taskboard Server, or the tsx process of an older install): Taskboard.
//     Children of the server that no rule above claimed also belong to Taskboard.
// groupProcesses() is a pure function of the process table, so tests give it a fake table.
//
// Energy impact is the POWER column of `top -l 2 -s 1` (the second sample; the first one has no time base). It needs no
// root but takes about 2 s, so it is read only when asked for (?power=1). ps gives CPU and memory (RSS) in an instant.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { promisify } from 'node:util';
import { TB_DIR } from './config.ts';
import * as browser from './task-browser.ts';
import { identity, matchesBrowser, profileLockPid } from './browser-recovery.ts';

const exec = promisify(execFile);
export interface PsRow { pid: number; ppid: number; uid?: number; cpu: number; rssKb: number; etime: string; name: string; args: string; threads?: number }
export interface ProcInput {
  rows: PsRow[];
  serverPid: number;
  tmuxServerPid: number | null;
  panes: { session: string; panePid: number }[];
  tasks: { id: string; num: number; title: string; session: string; status?: string; lastActivity?: string }[];
  browsersDir: string;
  taskEnv: Map<number, string>;      // pid → TASK_ID, for processes outside the tree
  browserRoots?: Map<number, string>;
  power?: Map<number, number>;
}
export type ProcKind = 'server' | 'launcher' | 'tmux' | 'agent' | 'tb run' | 'browser' | 'mcp server' | 'test server' | 'shell' | 'process';
export interface ProcLine { pid: number; ppid: number; name: string; command: string; kind: ProcKind; cpu: number; memMb: number; power: number | null; ageSec: number | null }
export interface Totals { count: number; threads: number; cpu: number; memMb: number; power: number | null }
export interface ProcGroup { key: string; label: string; num?: number; title?: string; status?: string; lastActivity?: string; browserTabs?: number; totals: Totals; procs: ProcLine[] }
export interface ProcTable { at: string; power: boolean; totals: Totals; machine: Totals; groups: ProcGroup[]; unownedCandidates: { pid: number; name: string; reason: string }[]; containers?: { id: string; name: string; reason: string }[] }

export const TASKBOARD = 'taskboard';

// ps etime: [[dd-]hh:]mm:ss
export function etimeSec(s: string): number | null {
  const m = s.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  return m ? (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+m[3]) * 60 + (+m[4]) : null;
}

function kindOf(r: PsRow, i: ProcInput, agentPanes: Set<number>, procPanes: Set<number>): ProcKind {
  if (r.pid === i.serverPid) return 'server';
  if (r.pid === i.tmuxServerPid) return 'tmux';
  if (agentPanes.has(r.pid)) return 'agent';
  if (procPanes.has(r.pid)) return 'tb run';
  if (/Google Chrome|Chromium|--user-data-dir=/.test(r.args) || /^Google Chrome/.test(r.name)) return 'browser';
  if (/\bserver\/index\.ts\b/.test(r.args)) return 'test server';
  if (/mcp/i.test(r.args)) return 'mcp server';
  if (/^-?(zsh|bash|sh|fish|dash)$/.test(r.name)) return 'shell';
  if (/^tmux$/.test(r.name)) return 'tmux';
  return 'process';
}

export function groupProcesses(i: ProcInput): ProcTable {
  const byPid = new Map(i.rows.map(r => [r.pid, r]));
  const kids = new Map<number, number[]>();
  for (const r of i.rows) { const k = kids.get(r.ppid); if (k) k.push(r.pid); else kids.set(r.ppid, [r.pid]); }
  const owner = new Map<number, string>();
  const claim = (root: number, key: string) => {
    const stack = [root];
    while (stack.length) {
      const pid = stack.pop()!;
      if (owner.has(pid) || !byPid.has(pid)) continue;
      owner.set(pid, key);
      for (const c of kids.get(pid) || []) stack.push(c);
    }
  };
  const taskById = new Map(i.tasks.map(t => [t.id, t]));
  const taskBySession = new Map(i.tasks.map(t => [t.session, t]));
  const taskByNum = new Map(i.tasks.map(t => [t.num, t]));
  // 1. task browsers
  const prefix = i.browsersDir.replace(/\/+$/, '') + '/';
  for (const [pid, id] of i.browserRoots || []) claim(pid, taskById.has(id) ? id : TASKBOARD);
  for (const r of i.rows) {
    const at = r.args.indexOf(`--user-data-dir=${prefix}`);
    if (at < 0) continue;
    const id = r.args.slice(at + `--user-data-dir=${prefix}`.length).split('/')[0];
    claim(r.pid, taskById.has(id) ? id : TASKBOARD);
  }
  // 2. tmux panes
  const agentPanes = new Set<number>(), procPanes = new Set<number>();
  for (const p of i.panes) {
    const proc = p.session.match(/^proc-(\d+)$/);
    const t = proc ? taskByNum.get(Number(proc[1])) : taskBySession.get(p.session);
    (proc ? procPanes : agentPanes).add(p.panePid);
    claim(p.panePid, t ? t.id : TASKBOARD);
  }
  // 3. terminal views and terminal logs
  for (const r of i.rows) {
    const view = r.name === 'tmux' && r.args.match(/\battach(?:-session)?\b.*-t\s*=?([^\s:]+)/);
    const viewTask = view ? (view[1].match(/^proc-(\d+)$/) ? taskByNum.get(Number(view[1].slice(5))) : taskBySession.get(view[1])) : undefined;
    if (viewTask) { claim(r.pid, viewTask.id); continue; }
    const log = r.ppid === i.tmuxServerPid && r.args.match(/\/([A-Za-z0-9_-]+)\/terminal\.log\b/);
    if (log && taskById.has(log[1])) claim(r.pid, log[1]);
  }
  // 4. the tmux server
  if (i.tmuxServerPid) claim(i.tmuxServerPid, TASKBOARD);
  // 5. adopted processes with TASK_ID
  for (const [pid, id] of i.taskEnv) if (taskById.has(id)) claim(pid, id);
  // 6. the server and its launcher
  const server = byPid.get(i.serverPid);
  if (server && server.ppid > 1 && /Taskboard Server|^node$|tsx/.test(`${byPid.get(server.ppid)?.name} ${byPid.get(server.ppid)?.args}`)) owner.set(server.ppid, TASKBOARD);
  claim(i.serverPid, TASKBOARD);

  const groups = new Map<string, ProcGroup>();
  const hasPower = !!i.power;
  const empty = (): Totals => ({ count: 0, threads: 0, cpu: 0, memMb: 0, power: hasPower ? 0 : null });
  const add = (t: Totals, p: ProcLine, threads: number) => { t.count++; t.threads += threads; t.cpu += p.cpu; t.memMb += p.memMb; if (t.power !== null) t.power += p.power ?? 0; };
  const totals = empty();
  for (const [pid, key] of owner) {
    const r = byPid.get(pid)!;
    if (r.ppid === i.serverPid && /^(ps|top)$/.test(r.name)) continue; // the ps and top calls of this measurement
    let g = groups.get(key);
    if (!g) {
      const t = taskById.get(key);
      g = t ? { key, label: t.id === 'controller' ? 'Controller' : `#${t.num} ${t.title}`, num: t.num, title: t.title, status: t.status, lastActivity: t.lastActivity, totals: empty(), procs: [] } : { key, label: 'Taskboard', totals: empty(), procs: [] };
      groups.set(key, g);
    }
    const kind = r.pid === server?.ppid && key === TASKBOARD && r.pid !== i.serverPid ? 'launcher' : kindOf(r, i, agentPanes, procPanes);
    const line: ProcLine = { pid, ppid: r.ppid, name: r.name, command: r.name, kind, cpu: r.cpu, memMb: Math.round(r.rssKb / 1024), power: hasPower ? i.power!.get(pid) ?? 0 : null, ageSec: etimeSec(r.etime) };
    g.procs.push(line); add(g.totals, line, r.threads ?? 0); add(totals, line, r.threads ?? 0);
  }
  const round = (t: Totals) => { t.cpu = Math.round(t.cpu * 10) / 10; if (t.power !== null) t.power = Math.round(t.power * 10) / 10; };
  const list = [...groups.values()];
  for (const g of list) { round(g.totals); g.procs.sort((a, b) => b.cpu - a.cpu || b.memMb - a.memMb); }
  round(totals);
  list.sort((a, b) => (a.key === TASKBOARD ? -1 : b.key === TASKBOARD ? 1 : b.totals.cpu - a.totals.cpu || b.totals.memMb - a.totals.memMb));
  const machine = empty();
  for (const r of i.rows) {
    machine.count++; machine.threads += r.threads ?? 0; machine.cpu += r.cpu; machine.memMb += Math.round(r.rssKb / 1024);
  }
  round(machine);
  const unownedCandidates = i.rows.filter(r => !owner.has(r.pid) && /Chrome|Chromium|Docker|docker|containerd/i.test(r.name)
    && !/Helper/.test(r.name) && (r.ppid === 1 || !byPid.has(r.ppid) || !/Chrome|Chromium/.test(byPid.get(r.ppid)!.name)))
    .map(r => ({ pid: r.pid, name: r.name, reason: 'No verified Taskboard owner. Review only.' }));
  return { at: new Date().toISOString(), power: hasPower, totals, machine, groups: list, unownedCandidates };
}

// ---------- reading the system ----------
// The live reader uses ucomm, the kernel process name. It never reads command arguments.
export function parsePs(stats: string, argsOut: string): PsRow[] {
  const args = new Map<number, string>();
  for (const l of argsOut.split('\n')) { const m = l.match(/^\s*(\d+)\s(.*)$/); if (m) args.set(Number(m[1]), m[2].trim()); }
  const rows: PsRow[] = [];
  for (const l of stats.split('\n')) {
    const m = l.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    rows.push({ pid, ppid: Number(m[2]), uid: Number(m[3]), cpu: Number(m[4]), rssKb: Number(m[5]), etime: m[6], name: m[7].trim(), args: args.get(pid) ?? m[7].trim() });
  }
  return rows;
}

export function parseSafePs(stats: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const l of stats.split('\n')) {
    const m = l.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), cpu: Number(m[4]), rssKb: Number(m[5]), etime: m[6], threads: Number(m[7]), name: m[8].trim(), args: m[8].trim() });
    else {
      const old = l.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (old) rows.push({ pid: Number(old[1]), ppid: Number(old[2]), uid: Number(old[3]), cpu: Number(old[4]), rssKb: Number(old[5]), etime: old[6], name: old[7].trim(), args: old[7].trim() });
    }
  }
  return rows;
}

// Profile locks and browser.json identify candidate roots without reading process arguments.
export function recordedBrowserRoots(rows: PsRow[], browsersDir: string): Map<number, string> {
  const byPid = new Map(rows.map(r => [r.pid, r]));
  const roots = new Map<number, string>();
  if (!existsSync(browsersDir)) return roots;
  for (const id of readdirSync(browsersDir)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(id)) continue;
    let meta: { pid?: number };
    try { meta = JSON.parse(readFileSync(join(browsersDir, id, 'browser.json'), 'utf8')); } catch { continue; }
    const pid = meta.pid;
    if (!pid || !byPid.get(pid)?.name.match(/Chrome|Chromium/)) continue;
    let lockPid = 0;
    try { const link = readlinkSync(join(browsersDir, id, 'profile', 'SingletonLock')); lockPid = Number(link.slice(link.lastIndexOf('-') + 1)); } catch { /* no lock */ }
    if (lockPid === pid) roots.set(pid, id);
  }
  return roots;
}

// The second sample of `top -l 2 -s 1 -stats pid,power`: lines "PID POWER" after the second header.
export function parseTopPower(out: string): Map<number, number> {
  const parts = out.split(/^PID\s+POWER\s*$/m);
  const last = parts.length > 2 ? parts[parts.length - 1] : '';
  const m = new Map<number, number>();
  for (const l of last.split('\n')) { const x = l.trim().match(/^(\d+)\s+([\d.]+)$/); if (x) m.set(Number(x[1]), Number(x[2])); }
  return m;
}

// TASK_ID from the environment of processes (ps -E lists it for processes of this user)
export function parseTaskEnv(out: string): Map<number, string> {
  const m = new Map<number, string>();
  for (const l of out.split('\n')) { const x = l.match(/^\s*(\d+)\s.*?\bTASK_ID=([A-Za-z0-9_-]+)/); if (x) m.set(Number(x[1]), x[2]); }
  return m;
}

export async function readProcesses(o: { tmux: (...a: string[]) => Promise<string>; tasks: ProcInput['tasks']; power: boolean }): Promise<ProcTable> {
  const big = { maxBuffer: 64 * 1024 * 1024, timeout: 10_000, encoding: 'utf8' as const };
  const powerP = o.power && process.platform === 'darwin' ? exec('top', ['-l', '2', '-s', '1', '-stats', 'pid,power'], big).then(r => parseTopPower(r.stdout)).catch(() => undefined) : Promise.resolve(undefined);
  const [stats, panesOut, tmuxPid] = await Promise.all([
    exec('ps', ['-axo', `pid=,ppid=,uid=,pcpu=,rss=,etime=,${process.platform === 'darwin' ? 'thcount' : 'nlwp'}=,ucomm=`], big).then(r => r.stdout)
      .catch(() => exec('ps', ['-axo', 'pid=,ppid=,uid=,pcpu=,rss=,etime=,ucomm='], big).then(r => r.stdout)),
    o.tmux('list-panes', '-a', '-F', '#{session_name}|~|#{pane_pid}').catch(() => ''),
    o.tmux('display-message', '-p', '#{pid}').then(s => Number(s.trim()) || null).catch(() => null),
  ]);
  const rows = parseSafePs(stats);
  const panes = panesOut.split('\n').filter(l => l.includes('|~|')).map(l => { const [session, pid] = l.split('|~|'); return { session, panePid: Number(pid) }; });
  const browsersDir = join(TB_DIR, 'browsers');
  const browserRoots = recordedBrowserRoots(rows, browsersDir);
  for (const [pid, id] of browserRoots) {
    if (!matchesBrowser(browser.readMeta(id), identity(pid), profileLockPid(id), process.getuid?.() ?? -1)) browserRoots.delete(pid);
  }
  const table = groupProcesses({ rows, serverPid: process.pid, tmuxServerPid: tmuxPid, panes, tasks: o.tasks, browsersDir, browserRoots, taskEnv: new Map(), power: await powerP });
  await Promise.all(table.groups.filter(g => g.key !== TASKBOARD).map(async g => {
    const meta = browser.readMeta(g.key);
    g.browserTabs = meta.pid && browserRoots.has(meta.pid) ? (await browser.tabs(g.key)).length : (meta.tabs || []).length;
  }));
  try {
    const output = (await exec('docker', ['ps', '--format', '{{.ID}}|{{.Names}}'], { timeout: 3000, maxBuffer: 1024 * 1024 })).stdout;
    table.containers = output.split('\n').filter(Boolean).map(line => {
      const [id, name] = line.split('|');
      return { id, name, reason: 'No Taskboard owner record. Review only.' };
    });
  } catch { /* Docker is unavailable */ }
  return table;
}
