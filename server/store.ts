// Tasks are Markdown notes in the vault: ~/AgentVault/tasks/<id>.md (frontmatter = task fields, body = description).
// Each task also has a folder ~/AgentVault/tasks/<id>/ with log.md (agent-written) and terminal.log (tmux pipe-pane).
import matter from 'gray-matter';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { TASKS_DIR, TB_DIR } from './config.ts';

export type Status = 'working' | 'needs-you' | 'unread' | 'idle' | 'stopped' | 'review' | 'suspended' | 'parked' | 'archived';
export type Agent = 'claude' | 'codex' | 'antigravity';

export interface Task {
  id: string;
  num: number;
  title: string;
  agent: Agent;
  status: Status;
  cwd: string;
  folder: string;          // the folder you picked; cwd differs when a worktree was created
  branch?: string;
  worktree?: boolean;
  session: string;         // tmux session name
  sessionId?: string;      // Claude session id / Codex thread id / Antigravity conversation id, used to resume
  pastSessions?: string[]; // replaced session ids, including account moves; kept out of the Import list
  transcript?: string;
  handoff?: string; // saved prompt for a replacement conversation, also used if startup needs a retry
  created: string;
  updated: string;
  statusAt: string;        // when the status last changed (drives "waiting 14 min")
  statusSource?: string;
  goal?: string;           // your words
  now?: string;            // where the agent is (last assistant message)
  ask?: string;            // what it waits for
  stopReason?: string;
  seenAt?: string;         // when you last opened the task
  interrupted?: string;
  groups?: string[];
  account?: string;        // account id (settings folder) the agent runs with
  accountChosen?: 'auto' | 'user'; // who chose the account: the automatic choice may move a failed first start once
  limitRetry?: string;     // the account a failed first start left (set once, so the retry happens only one time)
  model?: string;          // model selected for this task
  role?: 'controller';     // the controller agent is a task with this role; it is kept out of the task lists
  parent?: string;         // task id that started this one (the controller)
  links?: TaskLink[];      // links from this task to other tasks (server/links.ts); the other direction is computed
  imported?: string;       // where the session came from, when it was imported
  openElsewhere?: { pid: number; tty: string }; // imported while still open in another terminal
  moveWhenDone?: boolean;
  restartWhenDone?: boolean; // restart the agent (same conversation) as soon as its current turn ends
  restartWhenDoneAt?: string; // when restartWhenDone was set; after RESTART_WAIT_MS the task offers "Restart now" (index.ts)
  restartFor?: string;      // why the restart waits, for the task page: "to give access to the new worktree <name>"
  restartWait?: string;     // why the restart has not run yet (server/scope-restart.ts restartWaitReason)
  restartOverdue?: boolean; // the turn did not end within RESTART_WAIT_MS: the task shows "Restart now"
  restartFailed?: string;   // the reason of the last failed restart, shown on the task until a start succeeds
  newSessionWhenDone?: boolean; // controller: start it in a new conversation as soon as its current turn ends
  unscrollable?: boolean;    // running full screen without mouse support (Codex started before --no-alt-screen)
  launchedAs?: string; // controller: the name / Remote Control / agent it was started with (restarted when these change)
  remoteUrl?: string; // controller: its Remote Control address on claude.ai (read from its screen) // take the session over from that terminal as soon as its current turn ends
  // worktrees and read folders that the user approved after the start (tb scope request, server/scopes.ts)
  scopes?: Scope[];
  scopeNotice?: string; // the text that Taskboard puts in the inbox after the restart that gives the agent a new scope
  // only on the copy of a task that tb git uses for one attached worktree (scopes.gitView); never saved
  scopeKey?: string;
  transfer?: { id: string; machine: string; task: string; direction: 'source' | 'target'; state: 'staged' | 'starting' | 'started' | 'failed'; worktreeCreated?: boolean; peerIdentity?: string };
  desc: string;
}

// One link from a task to another task (server/links.ts). kind, read from the task that holds the link:
// dependsOn: this task is blocked by `to` · replaces: this task replaces `to` (folded: the work of `to` went into this
// task) · followUpOf: this task continues `to` · relatedTo: both tasks are about the same subject.
export type LinkKind = 'dependsOn' | 'replaces' | 'followUpOf' | 'relatedTo';
export interface LinkActor { actor: 'user' | 'controller' | 'task' | 'taskboard'; task?: string }
export interface TaskLink {
  id: string; kind: LinkKind; to: string; note?: string; folded?: boolean; at: string; by: LinkActor;
  doneAt?: string; doneBy?: LinkActor; doneNote?: string; // dependsOn only: set by tb dep done
}

// One approved scope of a task. kind 'worktree': a linked worktree on a new branch in repo (the main checkout).
// kind 'read': one more folder that the agent may read.
export interface Scope {
  id: string; kind: 'worktree' | 'read'; name: string; path: string; at: string; reason: string;
  repo?: string; branch?: string; base?: string; baseCommit?: string;
}

const now = () => new Date().toISOString();
const tasks = new Map<string, Task>();
const listeners = new Set<(t: Task) => void>();
// version: changes with every change of a task, so other modules can keep values computed from all tasks until the
// next change (links.ts). sorted: the tasks by number, newest first, until a task is added or removed.
let changes = 0, sorted: Task[] | null = null;
export const version = () => changes;
const changed = (order = false) => { changes++; if (order) sorted = null; };

export function onTaskChange(fn: (t: Task) => void) { listeners.add(fn); return () => listeners.delete(fn); }
export const taskDir = (id: string) => join(TASKS_DIR, id);
export const logFile = (id: string) => join(taskDir(id), 'log.md');
export const terminalLog = (id: string) => join(taskDir(id), 'terminal.log');

function write(t: Task) {
  const { desc, ...fm } = t;
  const clean = Object.fromEntries(Object.entries(fm).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  writeFileSync(join(TASKS_DIR, t.id + '.md'), matter.stringify(`# ${t.title}\n\n${desc}\n`, clean));
}

export function loadAll() {
  for (const f of readdirSync(TASKS_DIR)) {
    if (!f.endsWith('.md')) continue;
    try {
      const { data, content } = matter(readFileSync(join(TASKS_DIR, f), 'utf8'));
      const desc = content.replace(/^# .*\n+/, '').trim();
      tasks.set(data.id, { ...(data as Task), desc });
    } catch (e) { console.error('could not read task', f, e); }
  }
  changed(true);
}

// A copy of the sorted list: the sort ran for each call before, and some requests call this once for each task.
export function all(): Task[] { return (sorted ||= [...tasks.values()].sort((a, b) => b.num - a.num)).slice(); }
export function get(id: string) { return tasks.get(id); }

export function nextNum(): number {
  const file = join(TB_DIR, 'counter');
  const n = (existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0) + 1;
  writeFileSync(file, String(n));
  return n;
}

export function create(t: Omit<Task, 'created' | 'updated' | 'statusAt'>): Task {
  const full: Task = { ...t, created: now(), updated: now(), statusAt: now() };
  mkdirSync(taskDir(t.id), { recursive: true });
  if (!existsSync(logFile(t.id))) writeFileSync(logFile(t.id), `# Log: ${t.title}\n`);
  tasks.set(t.id, full); changed(true); write(full); emit(full);
  return full;
}

export function update(id: string, patch: Partial<Task>): Task | undefined {
  const t = tasks.get(id); if (!t) return;
  const statusChanged = patch.status && patch.status !== t.status;
  Object.assign(t, patch, { updated: now() }, statusChanged ? { statusAt: now() } : {});
  changed('num' in patch);
  write(t);
  if (statusChanged && t.status === 'archived' && t.role !== 'controller')
    try { appendFileSync(join(TB_DIR, 'daily-archive-events.jsonl'), JSON.stringify({ id: t.id, at: t.statusAt }) + '\n'); }
    catch (e) { console.error('could not record archive date', e); }
  emit(t);
  return t;
}

// Take a task off the board: its note and folder move to ~/.taskboard/trash/<id>-<time>/ (not deleted).
// The agent's own conversation files (~/.claude, ~/.codex) are not touched.
// when each agent was last started or resumed (a resume makes Codex write to its session file, which is not work)
export const launchedAt = new Map<string, number>();

export function remove(id: string) {
  const dest = join(TB_DIR, 'trash', `${id}-${Date.now()}`);
  mkdirSync(dest, { recursive: true });
  for (const p of [join(TASKS_DIR, id + '.md'), taskDir(id)]) if (existsSync(p)) renameSync(p, join(dest, basename(p)));
  tasks.delete(id);
  changed(true);
  launchedAt.delete(id);
  for (const fn of removeListeners) fn(id);
}
export function discardStagedTransfer(id: string) {
  const t = tasks.get(id);
  if (!t || t.transfer?.direction !== 'target' || !['staged', 'failed'].includes(t.transfer.state)) throw new Error('Only a staged or failed transfer can be discarded.');
  rmSync(join(TASKS_DIR, id + '.md'), { force: true });
  rmSync(taskDir(id), { recursive: true, force: true });
  tasks.delete(id);
  changed(true);
  launchedAt.delete(id);
  for (const fn of removeListeners) fn(id);
}
const removeListeners = new Set<(id: string) => void>();
export const onTaskRemoved = (fn: (id: string) => void) => { removeListeners.add(fn); };

function emit(t: Task) { for (const fn of listeners) fn(t); }
// tell listeners about a change that is not in the task note itself (for example new outbox files)
export function touch(id: string) { const t = tasks.get(id); if (t) emit(t); }

export function appendLog(id: string, entry: { did: string; wait?: string; next?: string }) {
  const stamp = new Date().toLocaleString('sv-SE').slice(0, 16);
  appendFileSync(logFile(id), `\n## ${stamp}\n- Did: ${entry.did}\n- Waiting: ${entry.wait || 'Nothing.'}\n- Next: ${entry.next || '—'}\n`);
}

export function readLog(id: string) {
  const f = logFile(id); return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

// Small persistent server state: folders you start tasks in, UI state.
const stateFile = join(TB_DIR, 'state.json');
export const state: { folders: Record<string, { uses: number; last: string; pinned?: boolean }>; ui: Record<string, unknown> } =
  existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { folders: {}, ui: {} };
export function saveState() { writeFileSync(stateFile, JSON.stringify(state, null, 2)); }
