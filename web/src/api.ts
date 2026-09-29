// Client state: the task list, kept current by the server's /ws/events stream.
import { useSyncExternalStore } from 'react';

export type Agent = 'claude' | 'codex' | 'antigravity';
export const AGENT_NAME: Record<Agent, string> = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };
export const AGENTS = Object.keys(AGENT_NAME) as Agent[];
export type Status = 'working' | 'needs-you' | 'unread' | 'idle' | 'stopped' | 'review' | 'suspended' | 'parked' | 'archived';
export interface Task {
  id: string; num: number; title: string; agent: Agent; status: Status;
  cwd: string; folder: string; branch?: string; worktree?: boolean; session: string; sessionId?: string;
  created: string; updated: string; statusAt: string; statusSource?: string;
  goal?: string; now?: string; ask?: string; stopReason?: string; interrupted?: string; desc: string;
  waitMin: number; attach: string; docs?: { inbox: number; outbox: number }; role?: 'controller'; parent?: string; account?: string; model?: string; machine?: { id: string; name: string }; imported?: string; openElsewhere?: { pid: number; tty: string }; moveWhenDone?: boolean; remoteUrl?: string; restartWhenDone?: boolean; unscrollable?: boolean;
}

export interface ImportCandidate {
  agent: Agent; sessionId: string; title: string; cwd: string; branch?: string; firstPrompt?: string; lastMessage?: string;
  updated: string; source?: string; running?: { pid: number; tty: string; exact: boolean };
}

export interface MachineInfo { role?: 'production' | 'sandbox'; root?: string; machine: string; host: string; url: string; settings: { name: string; routingRules: string; controller: { autostart: boolean; remoteControl: boolean }; permissions: { controllerNeedsApproval: boolean; agentsNeedApproval: boolean }; ask: { account: string; model: string } }; controller: null | { agent: string; account?: string; status: string; remoteUrl?: string; label: string } }
export interface Machine { id: string; name: string; url: string; local?: boolean; online: boolean; latency?: number; lastSeen?: string; error?: string; tasks?: number }
export interface Approval { id: string; actor: string; action: string; summary: string; detail: string; created: string; state: 'pending' | 'approved' | 'denied' | 'failed'; result?: string }
// questions about a task, answered by a separate read-only agent (server/ask.ts)
export interface AskItem { q: string; a?: string; state: 'running' | 'done' | 'failed' | 'stopped'; steps: string[]; costUsd?: number; ms?: number; model: string; account: string; at: string }
export interface AskThread { sessionId?: string; items: AskItem[] }
export interface Group { id: string; name: string; color: string; tasks: string[]; created: string }

export const STATUS_LABEL: Record<Status, string> = {
  'needs-you': 'Needs you', stopped: 'Stopped', review: 'Needs review', working: 'Working', unread: 'Done · unread',
  idle: 'Idle', suspended: 'Suspended', parked: 'Set aside', archived: 'Archived',
};
export const ORDER: Status[] = ['needs-you', 'stopped', 'review', 'unread', 'working', 'idle', 'suspended', 'parked', 'archived'];
export const ATTN: Status[] = ['needs-you', 'stopped', 'review'];

// Reload open pages when Taskboard is updated (Settings; saved per browser or app, default on).
let loadedBuild = '';
export const autoReload = () => { try { return localStorage.getItem('tb-autoreload') !== 'off'; } catch { return true; } };
export const setAutoReload = (on: boolean) => { try { localStorage.setItem('tb-autoreload', on ? 'on' : 'off'); } catch { /* storage off */ } };
// Ask before a canvas window's End & archive button acts (Settings; saved per browser or app, default off).
export const confirmEnd = () => { try { return localStorage.getItem('tb-confirm-end') === 'on'; } catch { return false; } };
export const setConfirmEnd = (on: boolean) => { try { localStorage.setItem('tb-confirm-end', on ? 'on' : 'off'); } catch { /* storage off */ } };
let tasks: Task[] = [];
let groups: Group[] = [];
let approvals: Approval[] = [];
let machines: Machine[] = [];
const loadMachines = () => fetch('/api/machines').then(r => r.json()).then(m => { machines = m; publish(); }).catch(() => {});
let connected = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach(f => f());
let snapshot = { tasks, groups, approvals, machines, connected };

let ws: WebSocket | null = null;
let viewingIds: string[] = [];

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/events`);
  ws.onopen = () => { connected = true; sendViewing(); loadMachines(); publish(); };
  ws.onclose = () => { connected = false; publish(); setTimeout(connect, 1500); };
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'hello') {
      // the first build seen is the one this page runs; a different one after a reconnect means Taskboard was updated
      if (!loadedBuild) loadedBuild = m.build;
      else if (m.build !== loadedBuild) {
        if (autoReload()) { location.reload(); return; }
        dispatchEvent(new CustomEvent('taskboard:update'));
      }
      return;
    }
    if (m.type === 'tasks') tasks = m.tasks;
    if (m.type === 'groups') groups = m.groups;
    if (m.type === 'approvals') approvals = m.approvals;
    if (m.type === 'machines') { loadMachines(); return; }
    if (m.type === 'removed') tasks = tasks.filter(t => t.id !== m.id);
    if (m.type === 'task') { const i = tasks.findIndex(t => t.id === m.task.id); if (i >= 0) tasks = tasks.map(t => t.id === m.task.id ? m.task : t); else tasks = [m.task, ...tasks]; notifyIfNeeded(m.task); }
    publish();
  };
}
function publish() { snapshot = { tasks, groups, approvals, machines, connected }; emit(); }
connect();

export function useStore() {
  return useSyncExternalStore(cb => { subs.add(cb); return () => subs.delete(cb); }, () => snapshot);
}

// Tell the server which tasks are open, so a finished turn in a task you are looking at is not "unread".
export function setViewing(ids: string[]) { viewingIds = ids; sendViewing(); }
function sendViewing() { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'viewing', ids: viewingIds })); }

async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data as { error?: string }).error || r.statusText);
  return data as T;
}
export const api = {
  create: (b: { title: string; desc: string; agent: string; folder: string; worktree?: boolean; branch?: string; account?: string; model?: string; machine?: string }) => call<Task>('POST', '/api/tasks', b),
  setStatus: (id: string, status: string) => call('POST', `/api/tasks/${id}/status`, { status }),
  seen: (id: string) => call('POST', `/api/tasks/${id}/seen`, {}),
  resume: (id: string, force = false) => call<Task>('POST', `/api/tasks/${id}/resume`, { force }),
  importList: () => call<ImportCandidate[]>('GET', '/api/import'),
  importItems: (items: ImportCandidate[]) => call<{ made: Task[]; errors: string[] }>('POST', '/api/import', { items }),
  send: (id: string, text: string) => call('POST', `/api/tasks/${id}/send`, { text }),
  kill: (id: string) => call('POST', `/api/tasks/${id}/kill`, {}),
  restart: (id: string, when: 'now' | 'after-turn' | 'cancel') => call<Task>('POST', `/api/tasks/${encodeURIComponent(id)}/restart`, { when }),
  remove: (id: string) => call('DELETE', `/api/tasks/${encodeURIComponent(id)}`),
  info: () => call<MachineInfo>('GET', '/api/info'),
  updateInfo: (patch: { name?: string; routingRules?: string; autostart?: boolean; remoteControl?: boolean; controllerNeedsApproval?: boolean; agentsNeedApproval?: boolean; askAccount?: string; askModel?: string }) => call<MachineInfo>('PATCH', '/api/info', patch),
  setControllerAccount: (account: string) => call<Task>('POST', '/api/controller/account', { account }),
  // sent as raw bytes; octet-stream so the server's JSON parser leaves .json files alone
  upload: async (id: string, file: File) => {
    const r = await fetch(`/api/tasks/${encodeURIComponent(id)}/inbox/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Upload failed (${r.status})`);
    return r.json() as Promise<{ path: string }>;
  },
  takeover: (id: string, when: 'now' | 'after-turn' | 'cancel' = 'now') => call<Task>('POST', `/api/tasks/${id}/takeover`, { when }),
  since: (id: string) => call<{ since: string; first: boolean; entries: string[]; files: string[]; commits: string[] }>('GET', `/api/tasks/${id}/since`),
  log: (id: string) => call<string>('GET', `/api/tasks/${id}/log`),
  addMachine: (name: string, url: string, token: string) => call<Machine>('POST', '/api/machines', { name, url, token }),
  removeMachine: (id: string) => call('DELETE', `/api/machines/${id}`),
  foldersOn: (machine: string) => call<{ used: { path: string; uses: number; last: string; pinned?: boolean }[]; found: string[] }>('GET', `/api/folders${machine && machine !== 'local' ? '?machine=' + machine : ''}`),
  folders: () => call<{ used: { path: string; uses: number; last: string; pinned?: boolean }[]; found: string[] }>('GET', '/api/folders'),
  pin: (path: string, pinned: boolean) => call('POST', '/api/folders/pin', { path, pinned }),
  sendDoc: (from: string, name: string, to: string) => call('POST', '/api/docs/send', { from, name, to }),
  removeInbox: (id: string, name: string) => call('POST', `/api/tasks/${id}/inbox/remove`, { name }),
  tellInbox: (id: string) => call<{ told: boolean }>('POST', `/api/tasks/${id}/inbox/tell`, {}),
  decide: (id: string, approve: boolean) => call<Approval>('POST', `/api/approvals/${id}/${approve ? 'approve' : 'deny'}`, {}),
  moveAccount: (id: string, account: string) => call<Task>('POST', `/api/tasks/${id}/move-account`, { account }),
  startController: () => call<Task>('POST', '/api/controller/start', {}),
  createGroup: (name: string, tasks: string[] = []) => call<Group>('POST', '/api/groups', { name, tasks }),
  updateGroup: (id: string, patch: { name?: string; color?: string; tasks?: string[]; add?: string | string[]; remove?: string | string[] }) => call<Group>('PATCH', `/api/groups/${id}`, patch),
  deleteGroup: (id: string) => call<Group>('DELETE', `/api/groups/${id}`),
  restoreGroup: (g: Group) => call('POST', '/api/groups/restore', g),
  askThread: (id: string) => call<AskThread>('GET', `/api/tasks/${encodeURIComponent(id)}/ask`),
  ask: (id: string, question: string) => call<AskThread>('POST', `/api/tasks/${encodeURIComponent(id)}/ask`, { question }),
  askStop: (id: string) => call('POST', `/api/tasks/${encodeURIComponent(id)}/ask/stop`, {}),
  askClear: (id: string) => call<AskThread>('DELETE', `/api/tasks/${encodeURIComponent(id)}/ask`),
  getUi: () => call<Record<string, unknown>>('GET', '/api/ui'),
  putUi: (x: Record<string, unknown>) => call('PUT', '/api/ui', x),
};

// Desktop notification when an agent starts needing you (only after you allow notifications).
const lastStatus = new Map<string, Status>();
function notifyIfNeeded(t: Task) {
  const prev = lastStatus.get(t.id); lastStatus.set(t.id, t.status);
  if (prev === t.status || !ATTN.includes(t.status)) return;
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    new Notification(`#${t.num} ${STATUS_LABEL[t.status]}`, { body: `${t.title}${t.ask ? ' — ' + t.ask : ''}`, tag: t.id });
  }
}

export const fmtWait = (m: number) => m < 1 ? 'just now' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}`;
export const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');
