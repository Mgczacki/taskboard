// Import sessions you started outside Taskboard. Nothing in ~/.claude or ~/.codex is changed:
// Claude Code transcripts are read as files, Codex's thread list is read from its database in read-only mode.
// An imported session becomes a Suspended task; opening it resumes the same conversation inside Taskboard.
import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { HOME, TB_DIR } from './config.ts';

const exec = promisify(execFile);
const DAYS = 14;

export interface Candidate {
  agent: 'claude' | 'codex';
  sessionId: string;
  title: string;
  cwd: string;
  branch?: string;
  firstPrompt?: string;
  lastMessage?: string;
  updated: string;        // ISO time of last activity
  source?: string;        // Codex: cli / vscode
  running?: { pid: number; tty: string; exact: boolean };
  transcript?: string;    // file the CLI appends to; its modification time shows activity
}

// ---------- reading only the start and the end of large files ----------
function readSlice(file: string, start: number, len: number): string {
  const fd = openSync(file, 'r');
  try { const b = Buffer.alloc(len); const n = readSync(fd, b, 0, len, start); return b.subarray(0, n).toString('utf8'); } finally { closeSync(fd); }
}
function jsonLines(text: string, dropFirst: boolean): any[] {
  const lines = text.split('\n'); if (dropFirst) lines.shift();
  const out: any[] = [];
  for (const l of lines) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* cut line */ } }
  return out;
}
const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join(' ');
  return '';
};
const clip = (s = '', n = 300) => s.replace(/\s+/g, ' ').trim().slice(0, n);
const isRealPrompt = (s: string) => s.trim() && !s.startsWith('<') && !s.startsWith('Caveat:');

// ---------- Claude Code: ~/.claude/projects/<folder>/<session>.jsonl ----------
function claudeCandidates(): Candidate[] {
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude'), 'projects');
  if (!existsSync(root)) return [];
  const since = Date.now() - DAYS * 86400000;
  const out: Candidate[] = [];
  for (const dir of readdirSync(root)) {
    const d = join(root, dir);
    let files: string[] = [];
    try { files = readdirSync(d).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = join(d, f);
      const st = statSync(file);
      if (st.mtimeMs < since || st.size < 200) continue;
      const head = jsonLines(readSlice(file, 0, 96 * 1024), false);
      const tail = st.size > 96 * 1024 ? jsonLines(readSlice(file, Math.max(0, st.size - 256 * 1024), 256 * 1024), true) : head;
      const all = [...head, ...tail];
      const firstUser = head.find(j => j.type === 'user' && !j.isSidechain && !j.isMeta && isRealPrompt(textOf(j.message?.content)));
      if (!firstUser) continue; // no real conversation (only meta lines)
      if (head.some(j => j.isSidechain) && !head.some(j => j.type === 'user' && !j.isSidechain)) continue;
      const titleLine = [...all].reverse().find(j => j.type === 'ai-title' || j.type === 'custom-title' || j.type === 'summary');
      const lastAssistant = [...tail].reverse().find(j => j.type === 'assistant' && textOf(j.message?.content).trim());
      const lastTs = [...tail].reverse().find(j => j.timestamp)?.timestamp;
      out.push({
        agent: 'claude', sessionId: firstUser.sessionId || basename(f, '.jsonl'),
        title: clip(titleLine?.customTitle || titleLine?.aiTitle || titleLine?.summary || textOf(firstUser.message.content), 90),
        cwd: firstUser.cwd || '', branch: firstUser.gitBranch && firstUser.gitBranch !== 'HEAD' ? firstUser.gitBranch : undefined,
        firstPrompt: clip(textOf(firstUser.message.content), 400), lastMessage: clip(textOf(lastAssistant?.message?.content), 400),
        updated: lastTs || new Date(st.mtimeMs).toISOString(), transcript: file,
      });
    }
  }
  return out;
}

// ---------- Codex: threads table in $CODEX_HOME/state_*.sqlite (read-only) ----------
async function codexCandidates(): Promise<Candidate[]> {
  const home = process.env.CODEX_HOME || join(HOME, '.codex');
  if (!existsSync(home)) return [];
  const db = readdirSync(home).filter(f => /^state_\d+\.sqlite$/.test(f)).sort().pop();
  if (!db) return [];
  const since = Math.floor((Date.now() - DAYS * 86400000) / 1000);
  const sql = `select id, rollout_path, cwd, title, name, first_user_message, preview, git_branch, updated_at, source from threads
    where archived = 0 and source in ('cli','vscode') and updated_at > ${since} order by updated_at desc limit 300`;
  try {
    const { stdout } = await exec('sqlite3', ['-readonly', '-json', join(home, db), sql], { maxBuffer: 32 * 1024 * 1024 });
    const rows = stdout.trim() ? JSON.parse(stdout) : [];
    return rows.map((r: any) => ({
      agent: 'codex' as const, sessionId: r.id, title: clip(r.name || r.title || r.first_user_message, 90), cwd: r.cwd,
      branch: r.git_branch || undefined, firstPrompt: clip(r.first_user_message, 400), lastMessage: clip(r.preview, 400),
      updated: new Date(r.updated_at * 1000).toISOString(), source: r.source, transcript: r.rollout_path,
    }));
  } catch (e) { console.error('codex import', e); return []; }
}

// ---------- which sessions are open in a terminal right now ----------
interface Proc { pid: number; tty: string; agent: 'claude' | 'codex'; args: string[]; cwd?: string }
async function runningAgents(): Promise<Proc[]> {
  const { stdout } = await exec('ps', ['-Ao', 'pid=,tty=,args=']);
  const procs: Proc[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/); if (!m) continue;
    const [, pid, tty, cmd] = m; if (tty === '??') continue;
    const args = cmd.split(/\s+/); const name = basename(args[0]);
    if (name !== 'claude' && name !== 'codex') continue;
    if (['daemon', 'bg-spare', 'app-server', 'sandbox', 'mcp-server', 'exec'].includes(args[1] || '')) continue;
    procs.push({ pid: Number(pid), tty, agent: name, args });
  }
  if (procs.length) {
    try {
      const { stdout: lo } = await exec('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', procs.map(p => p.pid).join(',')]);
      let cur: Proc | undefined;
      for (const l of lo.split('\n')) {
        if (l.startsWith('p')) cur = procs.find(p => p.pid === Number(l.slice(1)));
        else if (l.startsWith('n') && cur) cur.cwd = l.slice(1);
      }
    } catch { /* lsof exits 1 when some pids vanished; partial output is fine */ }
  }
  return procs;
}
const argAfter = (args: string[], flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };

export async function candidates(knownSessionIds: Set<string>): Promise<Candidate[]> {
  const [cc, cx, procs] = await Promise.all([Promise.resolve(claudeCandidates()), codexCandidates(), runningAgents()]);
  const list = [...cc, ...cx].filter(c => !knownSessionIds.has(c.sessionId) && c.cwd && !/^\/(private\/)?(tmp|var\/folders)\//.test(c.cwd) && !c.cwd.startsWith(join(TB_DIR, 'ask')));
  for (const p of procs) {
    // exact: the session id is on the command line (codex resume <id>, claude --resume <id>)
    const exactId = p.agent === 'codex' ? (p.args[1] === 'resume' ? p.args[2] : undefined) : (argAfter(p.args, '--resume') || argAfter(p.args, '-r') || argAfter(p.args, '--session-id'));
    let c = exactId ? list.find(x => x.sessionId === exactId) : undefined;
    let exact = !!c;
    // otherwise: the most recent session of that agent in the process's folder
    if (!c && p.cwd) c = list.filter(x => x.agent === p.agent && x.cwd === p.cwd && !x.running).sort((a, b) => b.updated.localeCompare(a.updated))[0];
    if (c && !c.running) c.running = { pid: p.pid, tty: p.tty, exact };
  }
  return list.sort((a, b) => Number(!!b.running) - Number(!!a.running) || b.updated.localeCompare(a.updated));
}

// Where a session's transcript lives, for tasks imported before the path was recorded. accountDir is the task's
// account folder (CLAUDE_CONFIG_DIR / CODEX_HOME); without it, the default folder is searched.
export function transcriptFor(agent: 'claude' | 'codex', sessionId: string, accountDir?: string): string | undefined {
  const base = accountDir || (agent === 'claude' ? process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude') : process.env.CODEX_HOME || join(HOME, '.codex'));
  const root = join(base, agent === 'claude' ? 'projects' : 'sessions');
  const walk = (d: string, depth: number): string | undefined => {
    let entries: string[] = []; try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      const p = join(d, e);
      if (e.endsWith('.jsonl') && e.includes(sessionId)) return p;
      if (depth > 0 && !e.includes('.')) { const r = walk(p, depth - 1); if (r) return r; }
    }
  };
  return walk(root, agent === 'claude' ? 1 : 3);
}

export function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
