// Client state: the task list, kept current by the server's /ws/events stream.
import { useSyncExternalStore } from 'react';
import { eventRetry, restartBanner, type ServerHealth, type ServerLink } from './serverStatus';
import { countMessage } from './perfStats';

export type Agent = 'claude' | 'codex' | 'antigravity';
// GET /api/processes (server/processes.ts)
export interface ProcLine { pid: number; ppid: number; name: string; command: string; kind: string; cpu: number; memMb: number; power: number | null; ageSec: number | null }
export interface ProcTotals { count: number; cpu: number; memMb: number; power: number | null }
export interface ProcTable { at: string; power: boolean; totals: ProcTotals; groups: { key: string; label: string; num?: number; title?: string; totals: ProcTotals; procs: ProcLine[] }[] }
export const AGENT_NAME: Record<Agent, string> = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };
export const AGENTS = Object.keys(AGENT_NAME) as Agent[];
export type Status = 'working' | 'needs-you' | 'unread' | 'idle' | 'stopped' | 'review' | 'suspended' | 'parked' | 'archived';
export interface Task {
  id: string; num: number; title: string; agent: Agent; status: Status;
  cwd: string; folder: string; branch?: string; worktree?: boolean; session: string; sessionId?: string;
  created: string; updated: string; statusAt: string; statusSource?: string;
  goal?: string; now?: string; ask?: string; stopReason?: string; interrupted?: string; desc: string;
  // the length of the whole description when desc has only its start (the /ws/events task list, server/index.ts listView)
  descCut?: number;
  waitMin: number; waitSig?: string; attach: string; docs?: { inbox: number; outbox: number }; role?: 'controller'; parent?: string; links?: TaskLink[]; link?: LinkInfo; account?: string; model?: string; machine?: { id: string; name: string }; imported?: string; openElsewhere?: { pid: number; tty: string }; moveWhenDone?: boolean; remoteUrl?: string; restartWhenDone?: boolean; restartFor?: string; restartWait?: string; restartOverdue?: boolean; restartFailed?: string; newSessionWhenDone?: boolean; unscrollable?: boolean; tokenEstimate?: number | null;
  // the agent's open request for help in the task browser (tb browser ask)
  browserAsk?: string;
  scopes?: Scope[];
  // messages that Taskboard could not type into the agent yet (server/message-queue.ts), and inbox notices not delivered yet
  queue?: QueuedMessage[];
  transfer?: { id: string; machine: string; task: string; direction: 'source' | 'target'; state: 'staged' | 'starting' | 'started' | 'failed'; worktreeCreated?: boolean; peerIdentity?: string };
}

export interface QueuedMessage {
  id: string; kind: 'message' | 'review' | 'permit' | 'inbox'; from: string; text: string; state: 'queued' | 'failed'; reason: string; queued: string;
  // messages only: screen checks of the typing loop and what the last one saw, typing tries, older than 5 minutes,
  // the user chose Deliver by hook, and the hook events of this agent that deliver it (none for Codex)
  checks?: number; seen?: string; checkedAt?: string; tries?: number; late?: boolean; via?: 'hook'; hook?: string;
}
export type NoticeResult = { delivery: 'delivered' | 'queued' | 'failed'; reason?: string; resumed?: boolean };

export interface ImportCandidate {
  agent: Agent; sessionId: string; title: string; cwd: string; branch?: string; firstPrompt?: string; lastMessage?: string;
  updated: string; source?: string; running?: { pid: number; tty: string; exact: boolean };
}

export interface MachineInfo { role?: 'production' | 'sandbox'; root?: string; machine: string; machineId?: string; host: string; url: string; settings: { name: string; routingRules: string; newTaskDefaultAgent: Agent | 'auto'; controller: { autostart: boolean; remoteControl: boolean; agent?: Agent; skipPermissions?: Record<Agent, boolean>; accounts?: Partial<Record<Agent, string>>; dangerouslySkipPermissions: boolean; models: Record<Agent, string> }; permissions: { controllerNeedsApproval: boolean; agentsNeedApproval: boolean; trustWorkspaces: boolean; autoReview: boolean; controllerCanApprovePermits: boolean; holdPermissionHook?: boolean }; permitFolders: string[]; pushes: { taskBranches: 'run' | 'ask' | 'never'; ownRepositories: string[]; protectedBranches: string[] }; ask: { agent: 'claude' | 'codex'; account: string; model: string }; review: { account: string; model: string }; messages: { incoming: MessageLevel; outgoing: MessageLevel; checkPrivateNotes: boolean }; accounts: { defaultMaxParallel: number }; browser: { claude: BrowserMode; codex: BrowserMode; chromePath: string; idleStopMinutes: number; sharp?: boolean; scale?: 'screen' | 'one' | 'two'; autoSwitch?: boolean }; claudeInChrome?: { tasks: boolean; controller: boolean }; confirmRisk?: Partial<ConfirmRisk>; a2aNotes?: { slackClientId: string; slackTeamId: string }; controllerApprovals?: Partial<ControllerApprovals> }; controller: null | { agent: string; agentName?: string; account?: string; skipPermissions?: boolean; status: string; remoteUrl?: string; label: string }; tmuxProblem?: null | { pid: number; cwd: string | null; text: string; command: string; tasks: string[]; checkedAt: string }; tmuxSettings?: null | { socket: string; running: boolean; version: string; differ: string[]; checkedAt: string } }
// the user's rules files for the controller and for task sessions (server/rules.ts)
export type RulesKind = 'controller' | 'task';
export interface RulesFile { kind: RulesKind; file: string; text: string; chars: number; max: number; updated: string | null; preview: { lines: string[]; more: boolean } }
export interface Machine { id: string; name: string; url: string; identity?: string; local?: boolean; online: boolean; latency?: number; lastSeen?: string; error?: string; tasks?: number }
export async function linkedTaskId(identity: string | undefined, taskId: string): Promise<string | null> {
  if (!identity) return null;
  const match = (await call<Machine[]>('GET', '/api/machines')).find(machine => machine.identity === identity);
  return match ? (match.local ? taskId : `${match.id}~${taskId}`) : null;
}
export interface TransferCheck {
  machine: string; folder: string; fingerprint: string; ready: boolean; issues: string[];
  source: { root: string; remote: string; branch: string; head: string; changes: string[]; ignored: string[] };
  target: { root: string; remote: string; branch: string; head: string; changes: string[] };
  accounts: { id: string; name: string; agent: Agent; signedIn: boolean; unavailable?: string }[];
  files: { files: { path: string; size: number; hash: string }[]; omitted: string[] };
  workspace: { files: { path: string; size: number; hash: string }[]; omitted: string[] };
  transcript: { path: string; size: number; hash: string; available: boolean; reason?: string } | null;
  bundle: { available: boolean; size?: number; hash?: string; commits?: number; reason?: string } | null;
}
export type MessageLevel = 1 | 2 | 3;
// the processes and the browser of each task (server/task-procs.ts, server/task-browser.ts). A group owns none.
export type BrowserMode = 'off' | 'task' | 'only';
export type ProcScope = 'tasks';
export interface Proc { name: string; command: string; cwd: string; stop?: string; port?: number; startedBy: 'agent' | 'user'; state: 'starting' | 'running' | 'exited' | 'stopped' | 'suspended'; exitCode?: number; started?: string; ended?: string; window?: string; stopNote?: string; memMb?: number | null }
// server/runtime-summary.ts: the running counts of a task (pushed as the "runtime" event, only tasks with one or more)
// and the items of a set of tasks with memory (GET /api/runtime, read while a view is open)
export interface RuntimeCount { browser: number; procs: number }
export interface RuntimeItem { task: string; kind: 'browser' | 'proc'; name: string; state: string; port?: number; pages?: number; agents?: number; command?: string; memMb: number | null }
export interface RuntimeList { items: RuntimeItem[]; total: { browsers: number; procs: number; memMb: number } }
// dialog: a box that the page opened (alert, confirm, prompt, beforeunload) and that waits for an answer (server/task-browser.ts)
export interface BrowserTab { id: string; title: string; url: string; faviconUrl?: string; dialog?: { type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string; defaultPrompt?: string } }
export interface BrowserStatus { id: string; running: boolean; port?: number; tabs: BrowserTab[]; profile: boolean; copiedFromTemplate?: string; suspended?: boolean; idleStopped?: boolean; idleStopMinutes: number; startMs?: number; started?: string; stoppedAt?: string; error?: string; errorLines?: string[]; errorAt?: string; exited?: boolean; starting?: { seconds: number; limitSeconds: number; pid?: number }; systemMemory?: { totalMb: number; availableMb: number; availablePct: number; low: boolean } | null; memMb?: number | null; rssMb?: number | null; agents: number; viewers: number; chrome: string | null; sound: boolean; muted: boolean; soundState?: 'muted' | 'on' | 'unverified'; soundReason?: string; sharp?: boolean; check?: { chrome: string | null; node: string | null; mcp: boolean };
  // shared sign-ins (server/browser-signins.ts): noShared is the opt-out of this task browser, templateSites the number of
  // sites with cookies in the template (null: unknown), headed: the template is open in a normal Chrome window
  noShared?: boolean; syncedAt?: string; headed?: boolean; templateSites?: number | null;
  // the last sign-in for this task browser in the template's normal Chrome window (server/browser-signins.ts signinWindow)
  signinWindow?: SigninWindow }
export interface SigninWindow { sites: string[]; at: string; state: 'open' | 'copying' | 'done' | 'failed'; cookies?: number; error?: string }
// A site with cookies in a browser: the name and the count only, never a value.
export interface SigninSite { site: string; cookies: number; lastUsed?: string }
export interface SigninBrowser { id: string; num?: number; title?: string; status?: string; running: boolean; noShared: boolean; copiedFromTemplate?: string; syncedAt?: string; liveSyncAt?: string; agents: number }
export interface SigninOverview { template: { profile: boolean; running: boolean; headed: boolean; savedFrom?: { task: string; at: string } }; sites: SigninSite[] | null; settings: { live: boolean; liveSites: string[] }; browsers: SigninBrowser[] }
// A worktree or a read folder that the user approved after the task started (server/scopes.ts)
export interface Scope { id: string; kind: 'worktree' | 'read'; name: string; path: string; at: string; reason: string; repo?: string; branch?: string; base?: string; baseCommit?: string }
// An allow always rule (server/allow-rules.ts): a task may type into another task without a card
export type AllowScope = 'pair' | 'both' | 'any';
export interface AllowRule { id: string; kind: 'message' | 'doc'; scope: AllowScope; from?: string; fromNum?: number; fromTitle?: string; to: string; toNum: number; toTitle: string; created: string; card: string; by: 'user'; count: number; lastHour: number; lastAt?: string; text: string }
export interface Approval { id: string; actor: string; action: string; summary: string; detail: string; created: string; state: 'pending' | 'running' | 'approved' | 'denied' | 'failed' | 'expired' | 'unknown' | 'returned'; result?: string; staleFacts?: string; validUntil?: string; unblocks?: string[]; notifyMe?: boolean; returnable?: boolean; allow?: { kind: 'message' | 'doc'; from: string; to: string; choices: { scope: AllowScope; text: string }[]; limitText: string }; decidedBy?: { by: 'user' | 'controller'; userRequest?: string; at: string }; payload?: { permitId?: string; pushId?: string; state?: { forcePush?: boolean }; canPermit?: boolean; message?: string; hash?: string; body?: string; quality?: { state: string; flags: { text: string; start: number; end: number; reason: string; code?: string }[] } } & Partial<MessagePayload> }
// The structured part of an A2A Notes message card (server/a2anotes/cards.ts MessagePayload)
export interface MessageNote { code: string; title: string; text: string; todo: string; actions: ('recheck' | 'remove-flagged' | 'send-back' | 'approve-anyway')[] }
export interface MessagePayload {
  stage: 'draft' | 'checking' | 'held' | 'send' | 'incoming'; direction: 'in' | 'out'; task: string;
  peer: { name: string; address: string }; subject: string; audience: string; writer: { id: string; num?: number; title?: string };
  files: string[]; agentFile?: string; check: { verdict: string; reason: string; summary: string }; notes: MessageNote[];
  approver: string; since: string; remindAfterMin: number; error?: string; proposal?: { task: string | null; title?: string };
}
export interface Permit { id: string; taskId: string; taskNum: number; agent: Agent; reason: string; statedRisk?: string; createdAt: string; expiresAt: string; decidedAt?: string; finishedAt?: string; state: string; approvedBy?: string; approvalRule?: string; riskClass?: 'low' | 'high'; controllerRequestText?: string; decisionComment?: string; error?: string; riskFlags: string[]; steps: { command: string; cwd: string; timeoutSeconds: number; network: boolean; state: string; exitCode?: number | null; outputTail?: string; error?: string }[] }
// A question or dialog that a task waits on (server/pending.ts): the Waiting page, the notification stack, the task panel
export type PendingRisk = 'wide-access' | 'installs' | 'spends' | 'exits';
// Settings > Controller approvals: the card kinds that the controller may approve when the user asks in its chat
// (server/machine.ts controllerApprovals, server/controller-approve.ts)
export interface ControllerApprovals { merge: boolean; push: boolean; forcePush: boolean; release: boolean; restart: boolean; scope: boolean; permit: boolean; mail: boolean }
export const DEFAULT_CONTROLLER_APPROVALS: ControllerApprovals = { merge: true, push: true, forcePush: true, release: true, restart: true, scope: true, permit: true, mail: true };
// Settings: which risk kinds open the second confirm step on a card (server/machine.ts confirmRisk)
export interface ConfirmRisk { wideAccess: boolean; installs: boolean; spends: boolean; exits: boolean }
export const DEFAULT_CONFIRM_RISK: ConfirmRisk = { wideAccess: false, installs: true, spends: true, exits: true };
export const RISK_SETTING: Record<PendingRisk, keyof ConfirmRisk> = { 'wide-access': 'wideAccess', installs: 'installs', spends: 'spends', exits: 'exits' };
export interface PendingOption { key: string; label: string; description?: string; send: string; risk?: PendingRisk; deny?: boolean; selected?: boolean }
export interface PendingItem {
  id: string; taskId: string; taskNum: number; taskTitle: string; agent: Agent;
  kind: 'command' | 'choice' | 'text' | 'dialog' | 'plan' | 'signin' | 'unknown'; source: 'claude-hook' | 'screen' | 'turn-end'; name?: string;
  question: string; header?: string; options: PendingOption[];
  text?: { mode: 'answer' | 'deny' | 'change'; placeholder: string; send: string };
  questions?: { question: string; header?: string; options: { label: string; description?: string }[]; multiSelect: boolean }[];
  details?: { command?: string; cwd?: string; reason?: string; title?: string; plan?: string };
  screen?: { hash: string; excerpt: string; partial?: boolean };
  answerable: boolean; createdAt: string; state: 'pending' | 'sending' | 'answered' | 'gone' | 'failed'; result?: string; needsTerminal?: boolean;
  answer?: { by: 'user' | 'controller'; label: string; sent: string; at: string; rule?: string; tasks?: number[] };
  repeats?: { count: number; lastAnswer: string };
  sameIn?: { id: string; taskId: string; taskNum: number }[];
  sig?: string; dismissed?: { at: string; until?: string };
}
// An item that the user dismissed on the Waiting page (server/dismiss.ts). until: a held hook card shows again then.
export interface Dismissal { sig: string; kind: 'item' | 'task'; taskId: string; taskNum: number; title: string; question: string; label: string; at: string; until?: string }
export interface PushRecord { id: string; at: string; taskId: string; branch: string; remote: string; remoteUrl: string; oldHead: string | null; newHead: string; state: string; result?: string; approvalId?: string }
// questions about a task, answered by a separate read-only agent (server/ask.ts)
export interface AskItem { q: string; a?: string; state: 'running' | 'done' | 'failed' | 'stopped'; steps: string[]; costUsd?: number; ms?: number; agent?: 'claude' | 'codex'; model: string; account: string; at: string }
export interface AskThread { sessionId?: string; items: AskItem[] }
export interface SpinOffExchange { sourceNum: number; question: string; answer: string }
export interface Group { id: string; name: string; color: string; tasks: string[]; created: string; order?: number }

export const STATUS_LABEL: Record<Status, string> = {
  'needs-you': 'Needs you', stopped: 'Stopped', review: 'Needs review', working: 'Working', unread: 'Done · unread',
  idle: 'Idle', suspended: 'Suspended', parked: 'Set aside', archived: 'Archived',
};
// Links between tasks (server/links.ts). links: the links this task holds. link: the computed summary in both directions.
export type LinkKind = 'dependsOn' | 'replaces' | 'followUpOf' | 'relatedTo';
export interface LinkActor { actor: 'user' | 'controller' | 'task' | 'taskboard'; task?: string }
export interface TaskLink { id: string; kind: LinkKind; to: string; note?: string; folded?: boolean; at: string; by: LinkActor; doneAt?: string; doneBy?: LinkActor; doneNote?: string }
export interface LinkSuggestion { from: string; to: string; kind: LinkKind; reason: string }
export interface LinkSetTask { id: string; num: number; title: string; status: Status; state?: LinkInfo['state']; ask?: string }
export interface LinkSet {
  tasks: LinkSetTask[];
  counts: { waitsForYou: number; blocked: number; working: number; replaced: number; archived: number; other: number };
  chain: string[]; waiting: (LinkSetTask & { blockedBy: string[] })[]; replaced: (LinkSetTask & { by: string })[];
  links: (TaskLink & { from: string; done?: boolean })[];
}
export interface LinkSets { group?: { id: string; name: string }; sets: LinkSet[]; unlinked: number }
export interface LinkInfo { state?: 'done' | 'superseded' | 'blocked' | 'ready'; blockedBy?: string[]; waitedOnBy?: string[]; replacedBy?: string; count: number }
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
// the order of the terminals in each Canvas view that is not a group (server/canvasOrder.ts)
let canvasOrder: Record<string, string[]> = {};
let approvals: Approval[] = [];
let pending: PendingItem[] = [];
let answered: PendingItem[] = [];
// pending has the question cards that show; the dismissed ones are in dismissedPending (server/dismiss.ts)
let dismissedPending: PendingItem[] = [];
let dismissals: Dismissal[] = [];
let runtime: Record<string, RuntimeCount> = {};
let machines: Machine[] = [];
const loadMachines = () => fetch('/api/machines').then(r => r.json()).then(m => { machines = m; publish(); }).catch(() => {});
let confirmRisk: ConfirmRisk = DEFAULT_CONFIRM_RISK;
// every read or change of the machine settings updates the confirm setting that the cards use
function keepConfirmRisk(i: MachineInfo) { confirmRisk = { ...DEFAULT_CONFIRM_RISK, ...i.settings.confirmRisk }; publish(); return i; }
export const loadConfirmRisk = () => api.info().catch(() => {});
let connected = false;
// the connection to the server and its start data (serverStatus.ts); banner: the text after a restart, until dismissed
let link: ServerLink = { state: 'down', since: Date.now() };
let server: ServerHealth | null = null;
type Banner = { text: string; at: number } | null;
let banner: Banner = null;
let attempt = 0, openedAt = 0, retryTimer: ReturnType<typeof setTimeout> | undefined;
export const dismissBanner = () => { banner = null; publish(); };
const subs = new Set<() => void>();
const emit = () => subs.forEach(f => f());
let snapshot = { tasks, groups, canvasOrder, approvals, pending, answered, dismissedPending, dismissals, machines, connected, runtime, confirmRisk, link, server: server as ServerHealth | null, banner: banner as Banner };

let ws: WebSocket | null = null;
let viewingIds: string[] = [];

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/events`);
  ws.onopen = () => { connected = true; openedAt = Date.now(); link = { state: 'connected', since: Date.now() }; sendViewing(); loadMachines(); void loadConfirmRisk(); publish(); };
  ws.onclose = e => {
    connected = false;
    const next = eventRetry(attempt, openedAt ? Date.now() - openedAt : null, e.code);
    attempt = next.attempt;
    // the server answered and closed this page with a reason (server/slow-client.ts): show the reason
    const closed = openedAt && e.reason ? { code: e.code, reason: e.reason } : undefined;
    openedAt = 0;
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (offline) link = { state: 'offline', since: Date.now() };
    else if (link.state === 'connected' || link.state === 'offline') link = { state: 'down', since: Date.now(), closed };
    publish();
    retryTimer = setTimeout(() => { retryTimer = undefined; connect(); }, next.delay);
  };
  ws.onmessage = e => {
    countMessage(e.data);
    const m = JSON.parse(e.data);
    if (m.type === 'stopping') { link = { state: 'restarting', since: Date.now(), stopReason: m.reason, stopDetail: m.detail }; publish(); return; }
    if (m.type === 'hello') {
      const text = restartBanner(server, m.server || null);
      if (m.server) server = m.server;
      if (text) banner = { text, at: Date.now() };
      publish();
      // the first build seen is the one this page runs; a different one after a reconnect means Taskboard was updated
      if (!loadedBuild) loadedBuild = m.build;
      else if (m.build !== loadedBuild) {
        if (autoReload()) { location.reload(); return; }
        dispatchEvent(new CustomEvent('taskboard:update'));
      }
      return;
    }
    if (m.type === 'tasks') tasks = m.tasks;
    // the minutes that tasks wait (index.ts, each minute): only a task whose number changed gets a new object
    if (m.type === 'waits') { const w = m.waits as Record<string, number>; if (!tasks.some(t => w[t.id] !== undefined && w[t.id] !== t.waitMin)) return; tasks = tasks.map(t => w[t.id] !== undefined && w[t.id] !== t.waitMin ? { ...t, waitMin: w[t.id] } : t); }
    if (m.type === 'groups') groups = m.groups;
    if (m.type === 'canvasOrder') canvasOrder = m.orders;
    if (m.type === 'approvals') approvals = m.approvals;
    if (m.type === 'pending') { const items: PendingItem[] = m.items || []; pending = items.filter(i => !i.dismissed); dismissedPending = items.filter(i => i.dismissed); answered = m.answered || []; }
    if (m.type === 'dismissed') dismissals = m.entries || [];
    if (m.type === 'runtime') runtime = m.counts || {};
    if (m.type === 'machines') { loadMachines(); return; }
    if (m.type === 'removed') tasks = tasks.filter(t => t.id !== m.id);
    if (m.type === 'task') { const i = tasks.findIndex(t => t.id === m.task.id); if (i >= 0) tasks = tasks.map(t => t.id === m.task.id ? m.task : t); else tasks = [m.task, ...tasks]; notifyIfNeeded(m.task); }
    // a message that changes nothing here (for example "accounts", which the Accounts page reads itself) draws nothing
    if (!['tasks', 'waits', 'groups', 'canvasOrder', 'approvals', 'pending', 'dismissed', 'runtime', 'removed', 'task'].includes(m.type)) return;
    publishSoon();
  };
}
function publish() { cancelSoon(); snapshot = { tasks, groups, canvasOrder, approvals, pending, answered, dismissedPending, dismissals, machines, connected, runtime, confirmRisk, link, server, banner }; emit(); }
// Messages often come in bursts (a task, its question card and its runtime count). The page draws once for each burst:
// at the next animation frame, or after 250 ms when the page is hidden and draws no frames.
let soon: { frame: number; timer: ReturnType<typeof setTimeout> } | null = null;
function cancelSoon() { if (soon) { cancelAnimationFrame(soon.frame); clearTimeout(soon.timer); soon = null; } }
function publishSoon() { if (!soon) soon = { frame: requestAnimationFrame(publish), timer: setTimeout(publish, 250) }; }
connect();
// the network came back: try at once instead of waiting for the next retry
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { attempt = 0; if (!connected && retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; link = { state: 'down', since: Date.now() }; connect(); } });
  window.addEventListener('offline', () => { if (!connected) { link = { state: 'offline', since: Date.now() }; publish(); } });
}

// the groups as they are now, for an Undo that runs after the page has re-rendered
export const currentGroups = () => groups;
const subscribe = (cb: () => void) => { subs.add(cb); return () => { subs.delete(cb); }; };
export function useStore() {
  return useSyncExternalStore(subscribe, () => snapshot);
}
// One part of the store: the component draws again only when that part changes. pick must return a value that is kept
// between changes (a field of the snapshot), not a new object or array.
export function useStoreValue<T>(pick: (s: typeof snapshot) => T): T {
  return useSyncExternalStore(subscribe, () => pick(snapshot));
}
// the task list now, for code that runs outside of drawing (event handlers, link providers)
export const currentTasks = () => snapshot.tasks;

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
// GET /api/restart/check (server/restart.ts)
export interface RestartImpact { sessions: { num: number; title: string; status: string }[]; stops: { num: number; title: string; what: string }[]; notes: string[]; tmuxPid?: number; tmuxStops: boolean }
export interface RestartResult { ok: boolean; message: string; at: string; log: string; oldPid?: number; newPid?: number }
export const api = {
  restartCheck: () => call<RestartImpact>('GET', '/api/restart/check'),
  restartLast: () => call<RestartResult | null>('GET', '/api/restart/last'),
  serverHealth: () => call<ServerHealth | null>('GET', '/api/server'),
  processes: (power = false) => call<ProcTable>('GET', `/api/processes${power ? '?power=1' : ''}`),
  restartTaskboard: (confirm: boolean) => call<{ pid: number }>('POST', '/api/restart', { confirm }),
  rules: () => call<RulesFile[]>('GET', '/api/rules'),
  saveRules: (kind: RulesKind, text: string) => call<RulesFile>('PUT', `/api/rules/${kind}`, { text }),
  create: (b: { title: string; desc: string; agent: string; folder: string; worktree?: boolean; branch?: string; account?: string; model?: string; machine?: string; group?: string; images?: { type: string; data: string }[]; spinOff?: SpinOffExchange }) => call<Task>('POST', '/api/tasks', b),
  setStatus: (id: string, status: string) => call('POST', `/api/tasks/${id}/status`, { status }),
  addLink: (id: string, b: { kind: LinkKind; to: string; note?: string; folded?: boolean }) => call<TaskLink>('POST', `/api/tasks/${encodeURIComponent(id)}/links`, b),
  removeLink: (id: string, link: string) => call<TaskLink>('DELETE', `/api/tasks/${encodeURIComponent(id)}/links/${encodeURIComponent(link)}`),
  linkDone: (id: string, link: string, note?: string) => call<TaskLink>('POST', `/api/tasks/${encodeURIComponent(id)}/links/${encodeURIComponent(link)}/done`, { note }),
  linkSets: (q: { task?: string; group?: string }) => call<LinkSets>('GET', `/api/links/sets?${q.task ? `task=${encodeURIComponent(q.task)}` : `group=${encodeURIComponent(q.group || '')}`}`),
  linkSuggestions: () => call<LinkSuggestion[]>('GET', '/api/links/suggestions'),
  dismissSuggestion: (s: LinkSuggestion) => call('POST', '/api/links/suggestions/dismiss', { from: s.from, to: s.to, kind: s.kind }),
  seen: (id: string) => call('POST', `/api/tasks/${id}/seen`, {}),
  desc: (id: string) => call<{ desc: string }>('GET', `/api/tasks/${encodeURIComponent(id)}/desc`),
  resume: (id: string, force = false) => call<Task>('POST', `/api/tasks/${id}/resume`, { force }),
  importList: () => call<ImportCandidate[]>('GET', '/api/import'),
  importItems: (items: ImportCandidate[]) => call<{ made: Task[]; errors: string[] }>('POST', '/api/import', { items }),
  send: (id: string, text: string) => call('POST', `/api/tasks/${id}/send`, { text }),
  typeCommand: (id: string, command: string) => call<{ ran: boolean; message: string }>('POST', `/api/tasks/${encodeURIComponent(id)}/type-command`, { command }),
  kill: (id: string) => call('POST', `/api/tasks/${id}/kill`, {}),
  restart: (id: string, when: 'now' | 'after-turn' | 'cancel') => call<Task>('POST', `/api/tasks/${encodeURIComponent(id)}/restart`, { when }),
  remove: (id: string) => call('DELETE', `/api/tasks/${encodeURIComponent(id)}`),
  info: () => call<MachineInfo>('GET', '/api/info').then(keepConfirmRisk),
  updateInfo: (patch: { name?: string; routingRules?: string; newTaskDefaultAgent?: Agent | 'auto'; autostart?: boolean; remoteControl?: boolean; dangerouslySkipPermissions?: boolean; controllerSkipPermissions?: Partial<Record<Agent, boolean>>; controllerModels?: Partial<Record<Agent, string>>; controllerNeedsApproval?: boolean; agentsNeedApproval?: boolean; trustWorkspaces?: boolean; autoReview?: boolean; controllerCanApprovePermits?: boolean; holdPermissionHook?: boolean; permitFolders?: string[]; pushTaskBranches?: 'run' | 'ask' | 'never'; ownRepositories?: string[]; protectedBranches?: string[]; askAgent?: 'claude' | 'codex'; askAccount?: string; askModel?: string; reviewAccount?: string; reviewModel?: string; messageIncoming?: MessageLevel; messageOutgoing?: MessageLevel; checkPrivateNotes?: boolean; confirmLowerControl?: boolean; defaultMaxParallel?: number; applyMaxParallelToAll?: boolean; browserClaude?: BrowserMode; browserCodex?: BrowserMode; chromePath?: string; browserIdleStopMinutes?: number; browserSharp?: boolean; browserScale?: 'screen' | 'one' | 'two'; browserAutoSwitch?: boolean; confirmRisk?: Partial<ConfirmRisk>; a2aSlackClientId?: string; a2aSlackTeamId?: string; controllerApprovals?: Partial<ControllerApprovals> }) => call<MachineInfo>('PATCH', '/api/info', patch).then(keepConfirmRisk),
  agentLoad: () => call<{ agents: number; medianMb: number; totalMb: number; memMb: number; noteAbove: number }>('GET', '/api/agent-load'),
  setControllerAccount: (account: string) => call<Task>('POST', '/api/controller/account', { account }),
  setControllerAgent: (agent: Agent) => call<Task>('POST', '/api/controller/agent', { agent }),
  // sent as raw bytes; octet-stream so the server's JSON parser leaves .json files alone
  upload: async (id: string, file: File) => {
    const r = await fetch(`/api/tasks/${encodeURIComponent(id)}/inbox/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Upload failed (${r.status})`);
    return r.json() as Promise<{ path: string }>;
  },
  takeover: (id: string, when: 'now' | 'after-turn' | 'cancel' = 'now') => call<Task>('POST', `/api/tasks/${id}/takeover`, { when }),
  since: (id: string) => call<{ since: string; first: boolean; entries: string[]; files: string[]; commits: string[] }>('GET', `/api/tasks/${id}/since`),
  log: (id: string) => call<string>('GET', `/api/tasks/${id}/log`),
  tokenEstimate: (id: string) => call<{ tokens: number | null }>('GET', `/api/tasks/${encodeURIComponent(id)}/token-estimate`),
  addMachine: (name: string, url: string, token: string) => call<Machine>('POST', '/api/machines', { name, url, token }),
  removeMachine: (id: string) => call('DELETE', `/api/machines/${id}`),
  foldersOn: (machine: string) => call<{ used: { path: string; uses: number; last: string; pinned?: boolean }[]; found: string[] }>('GET', `/api/folders${machine && machine !== 'local' ? '?machine=' + machine : ''}`),
  folders: () => call<{ used: { path: string; uses: number; last: string; pinned?: boolean }[]; found: string[] }>('GET', '/api/folders'),
  pin: (path: string, pinned: boolean) => call('POST', '/api/folders/pin', { path, pinned }),
  sendDoc: (from: string, name: string, to: string) => call<{ path: string } & NoticeResult>('POST', '/api/docs/send', { from, name, to }),
  queueAction: (id: string, qid: string, action: 'retry' | 'remove' | 'hook' | 'type') => call<{ state?: 'delivered' | 'queued' | 'failed'; reason?: string }>('POST', `/api/tasks/${id}/queue/${encodeURIComponent(qid)}/${action}`),
  removeInbox: (id: string, name: string) => call('POST', `/api/tasks/${id}/inbox/remove`, { name }),
  tellInbox: (id: string) => call<{ told: boolean } & Partial<NoticeResult>>('POST', `/api/tasks/${id}/inbox/tell`, {}),
  decide: (id: string, approve: boolean) => call<Approval>('POST', `/api/approvals/${id}/${approve ? 'approve' : 'deny'}`, {}),
  permits: () => call<Permit[]>('GET', '/api/permits'),
  // 409 with ignored: the worktree holds ignored files that a removal deletes; send confirm to remove it anyway
  removeScope: async (id: string, name: string, confirm: boolean): Promise<{ result?: string; error?: string; ignored?: string[] }> => {
    const r = await fetch(`/api/tasks/${encodeURIComponent(id)}/scopes/${encodeURIComponent(name)}/remove`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm }) });
    const data = await r.json().catch(() => ({ error: r.statusText }));
    if (!r.ok && !(r.status === 409 && data.ignored)) throw new Error(data.error || r.statusText);
    return data;
  },
  permit: (id: string) => call<Permit>('GET', `/api/permits/${encodeURIComponent(id)}`),
  decidePermit: (id: string, approve: boolean, comment: string) => call<Permit>('POST', `/api/permits/${encodeURIComponent(id)}/decide`, { approve, comment }),
  pushes: () => call<PushRecord[]>('GET', '/api/git/pushes'),
  decidePush: (id: string, approve: boolean, comment: string) => call<PushRecord>('POST', `/api/git/pushes/${encodeURIComponent(id)}/decide`, { approve, comment }),
  permitRefusal: (id: string) => call<{ permit: Permit }>('POST', `/api/refusals/${encodeURIComponent(id)}/permit`, {}),
  // a message card goes back to the controller or to the agent that wrote the draft, with the comment
  answerPending: (id: string, body: { option?: string; text?: string; confirm?: boolean; group?: string[] }) => call<PendingItem>('POST', `/api/pending/${id}/answer`, body),
  hidePending: (id: string) => call('POST', `/api/pending/${id}/hide`, {}),
  // Dismiss: hide one waiting item until something new happens for it (server/dismiss.ts). The task status does not change.
  dismissItem: (id: string, label: string) => call<Dismissal>('POST', '/api/dismiss', { item: id, label }),
  dismissTask: (taskId: string, label: string) => call<Dismissal>('POST', '/api/dismiss', { task: taskId, label }),
  bringBack: (sig: string) => call<{ ok: boolean }>('POST', '/api/dismiss/bring-back', { sig }),
  giveBack: (id: string, comment: string) => call<Approval>('POST', `/api/approvals/${id}/return`, { comment }),
  allowAlways: (id: string, scope: AllowScope) => call<{ rule: AllowRule; approval: Approval }>('POST', `/api/approvals/${id}/allow-always`, { scope }),
  allowRules: () => call<{ rules: AllowRule[]; limitPerHour: number; limitText: string }>('GET', '/api/allow-rules'),
  revokeAllowRule: (id: string) => call<{ revoked: string }>('POST', `/api/allow-rules/${encodeURIComponent(id)}/revoke`, {}),
  revokeAllAllowRules: () => call<{ revoked: number }>('POST', '/api/allow-rules/revoke-all', {}),
  moveAccount: (id: string, account: string) => call<Task>('POST', `/api/tasks/${id}/move-account`, { account }),
  transferMachines: (id: string) => call<{ id: string; name: string; online: boolean }[]>('GET', `/api/tasks/${encodeURIComponent(id)}/transfer/machines`),
  transferCheck: (id: string, machine: string, folder: string) => call<TransferCheck>('POST', `/api/tasks/${encodeURIComponent(id)}/transfer/check`, { machine, folder }),
  transferMove: (id: string, body: { machine: string; folder: string; account: string; fingerprint: string; handoffOnly: boolean; useBundle: boolean; includeFiles: boolean; includeWorkspace: boolean; includeTranscript: boolean; stopNow: boolean }) => call<{ id: string; num: number; machine: string; machineIdentity?: string; transferId: string }>('POST', `/api/tasks/${encodeURIComponent(id)}/transfer/move`, body),
  transferRecover: (id: string, action: 'status' | 'retry-target' | 'resume-source') => call<{ state: string; target?: { id: string; num: number; state: string } }>('POST', `/api/tasks/${encodeURIComponent(id)}/transfer/recover`, { action }),
  startController: () => call<Task>('POST', '/api/controller/start', {}),
  newControllerSession: (when: 'now' | 'after-turn' | 'cancel') => call<Task>('POST', '/api/controller/new-session', { when }),
  createGroup: (name: string, tasks: string[] = []) => call<Group>('POST', '/api/groups', { name, tasks }),
  updateGroup: (id: string, patch: { name?: string; color?: string; tasks?: string[]; add?: string | string[]; remove?: string | string[] }) => call<Group>('PATCH', `/api/groups/${id}`, patch),
  reorderGroups: (ids: string[]) => call<Group[]>('POST', '/api/groups/order', { ids }),
  reorderGroupTasks: (id: string, ids: string[]) => call<Group>('POST', `/api/groups/${id}/order`, { ids }),
  setCanvasOrder: (view: string, ids: string[]) => call<Record<string, string[]>>('POST', '/api/canvas/order', { view, ids }),
  moveGroupTask: (taskId: string, fromId: string, toId: string) => call<Group[]>('POST', '/api/groups/move', { taskId, fromId, toId }),
  deleteGroup: (id: string, requireArchived = false) => call<Group>('DELETE', `/api/groups/${id}${requireArchived ? '?requireArchived=1' : ''}`),
  restoreGroup: (g: Group) => call('POST', '/api/groups/restore', g),
  askThread: (id: string) => call<AskThread>('GET', `/api/tasks/${encodeURIComponent(id)}/ask`),
  ask: (id: string, question: string) => call<AskThread>('POST', `/api/tasks/${encodeURIComponent(id)}/ask`, { question }),
  askStop: (id: string) => call('POST', `/api/tasks/${encodeURIComponent(id)}/ask/stop`, {}),
  askClear: (id: string) => call<AskThread>('DELETE', `/api/tasks/${encodeURIComponent(id)}/ask`),
  procs: (scope: ProcScope, id: string) => call<Proc[]>('GET', `/api/${scope}/${encodeURIComponent(id)}/procs`),
  startProc: (scope: ProcScope, id: string, b: { name: string; command: string; cwd?: string; stop?: string; port?: number }) => call<Proc>('POST', `/api/${scope}/${encodeURIComponent(id)}/procs`, b),
  procAction: (scope: ProcScope, id: string, name: string, action: 'stop' | 'restart' | 'remove') => call<unknown>('POST', `/api/${scope}/${encodeURIComponent(id)}/procs/${encodeURIComponent(name)}/${action}`, {}),
  procLog: (scope: ProcScope, id: string, name: string) => call<string>('GET', `/api/${scope}/${encodeURIComponent(id)}/procs/${encodeURIComponent(name)}/log?bytes=131072`),
  runtime: (ids: string[]) => call<RuntimeList>('GET', `/api/runtime?tasks=${ids.map(encodeURIComponent).join(',')}`),
  browser: (id: string) => call<BrowserStatus>('GET', `/api/tasks/${encodeURIComponent(id)}/browser`),
  browserAction: (id: string, action: 'start' | 'stop' | 'reset') => call<BrowserStatus>('POST', `/api/tasks/${encodeURIComponent(id)}/browser/${action}`, {}),
  browserSound: (id: string, on: boolean) => call<BrowserStatus & { restarted: boolean }>('POST', id === 'template' ? '/api/browser-template/sound' : `/api/tasks/${encodeURIComponent(id)}/browser/sound`, { on }),
  browserTemplate: () => call<BrowserStatus>('GET', '/api/browser-template'),
  // a file for the browser view (a pasted image, a file for a file chooser, a dropped file); the answer names it
  browserUpload: async (id: string, file: Blob, name = 'file') => {
    const data = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] || ''); r.onerror = () => reject(r.error); r.readAsDataURL(file); });
    return call<{ id: string }>('POST', `/api/tasks/${encodeURIComponent(id)}/browser/upload`, { name, type: file.type, data });
  },
  signinSites: (id: string) => call<{ sites: SigninSite[] | null }>('POST', `/api/tasks/${encodeURIComponent(id)}/browser/signins/sites`, {}),
  signinSaveTemplate: (id: string) => call<{ sites: SigninSite[] }>('POST', `/api/tasks/${encodeURIComponent(id)}/browser/signins/save-template`, {}),
  signinSync: (id: string, sites: string[]) => call<{ sites: string[]; cookies: number }>('POST', `/api/tasks/${encodeURIComponent(id)}/browser/signins/sync`, { sites }),
  signinWindow: (id: string, url: string) => call<SigninWindow>('POST', `/api/tasks/${encodeURIComponent(id)}/browser/signins/window`, { url }),
  signinShared: (id: string, on: boolean) => call<BrowserStatus>('POST', `/api/tasks/${encodeURIComponent(id)}/browser/signins/shared`, { on }),
  signinOverview: () => call<SigninOverview>('POST', '/api/browser-signins/overview', {}),
  signinRemove: (site: string) => call<SigninOverview>('POST', '/api/browser-signins/remove', { site }),
  signinSignOutAll: () => call<{ sites: string[]; now: string[]; later: string[] }>('POST', '/api/browser-signins/sign-out-all', {}),
  signinLive: (patch: { live?: boolean; liveSites?: string[] }) => call<{ live: boolean; liveSites: string[] }>('POST', '/api/browser-signins/live', patch),
  signinSend: (machine: string, sites: string[]) => call<{ machine: string; sites: string[]; cookies: number }>('POST', '/api/browser-signins/send', { machine, sites }),
  templateWindow: () => call<BrowserStatus>('POST', '/api/browser-template/window', {}),
  browserTemplateAction: (action: 'start' | 'stop') => call<BrowserStatus>('POST', `/api/browser-template/${action}`, {}),
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
