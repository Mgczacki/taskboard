// This machine's identity and the controller settings, in ~/.taskboard/machine.json.
// The name tells you which machine a controller or a Taskboard server belongs to (for example in the Claude mobile app,
// where the controller's Remote Control session is called "Taskboard controller · <name>").
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { TB_DIR, TASKS_DIR } from './config.ts';

// How a task's agent gets the task browser: off (no task browser), task (the task browser is added), only (the task
// browser, and the agent's other browser tools are turned off: Claude in Chrome for Claude Code, the Chrome extension
// backend for Codex). For Claude Code, the setting claudeInChrome decides Claude in Chrome in the modes off and task.
export type BrowserMode = 'off' | 'task' | 'only';
export interface MachineSettings {
  name: string;
  routingRules: string;
  newTaskDefaultAgent: 'auto' | 'claude' | 'codex' | 'antigravity';
  // agent: which CLI runs the controller (Settings > Controller agent). skipPermissions: for each agent, whether the
  // controller starts with that agent's own flag that removes its permission prompts (agents.ts controllerSkipFlags).
  // accounts: the account that the controller last used for each agent. dangerouslySkipPermissions is the older
  // Claude Code only setting; it is kept equal to skipPermissions.claude, so an older release reads the same value.
  controller: ControllerSettings;
  // actions through `tb` that act on other tasks (new, send, set aside, archive): run at once, or wait for Approve
  permissions: { controllerNeedsApproval: boolean; agentsNeedApproval: boolean; allTaskCommunication: boolean; trustWorkspaces: boolean; autoReview: boolean; controllerCanApprovePermits: boolean; holdPermissionHook: boolean };
  permitFolders: string[];
  permitRequestLimits: PermitRequestLimits;
  pushes: { taskBranches: 'run' | 'ask' | 'never'; ownRepositories: string[]; protectedBranches: string[] };
  // questions about a task (server/ask.ts): the separate agent, account, and model
  ask: { agent: 'claude' | 'codex'; account: string; model: string };
  review: { account: string; model: string };
  // the maximum number of running tasks for an account added later (server/accounts.ts create); the default accounts
  // keep their own maximum until the user applies this value to all accounts
  // probeLimited: false stops the automatic checks of limit marks (server/account-probe.ts); it is on when not set
  accounts: { defaultMaxParallel: number; probeLimited?: boolean };
  // the browser for each task (server/task-browser.ts); chromePath empty means the installed Google Chrome;
  // idleStopMinutes: a task browser without an agent command or a viewer for this time stops (0: never)
  // scale: the pixels of a task browser for each CSS pixel, set with --force-device-scale-factor at its start. 'screen'
  // (default) uses the device pixel ratio of the dashboard's screen (the last one that a view reported), 'one' 1 and
  // 'two' 2. With more pixels the Browser tab is sharp on a high-density screen, and agent screenshots are larger.
  // sharp: the older setting (true was 2); a settings file with sharp true and no scale reads as 'two'.
  // autoSwitch: the dashboard's browser view switches to a new tab or popup at once (server/tab-switch.ts)
  browser: { claude: BrowserMode; codex: BrowserMode; chromePath: string; idleStopMinutes: number; sharp: boolean; scale: BrowserScale; autoSwitch: boolean };
  // Claude in Chrome (the Claude extension in the user's own Chrome) for Claude Code sessions that Taskboard starts.
  // false: the command has --no-chrome, so Claude Code does not show the dialog "Claude in Chrome extension detected"
  // at start. true: Claude Code decides, and can show that dialog once.
  claudeInChrome: ClaudeInChrome;
  // the second confirm step on a card option with a risk (server/pending.ts answer, web PendingCard): true shows the
  // step, false sends the click at once. The controller never chooses such an option (pending.controllerRule).
  confirmRisk: ConfirmRisk;
  // the Slack app that A2A Notes setup uses (server/a2anotes/slack-app.ts); empty means the environment or the default
  a2aNotes: { slackClientId: string; slackTeamId: string };
  // Settings > Controller approvals: the kinds of dashboard cards that the controller may approve when the user asks in
  // its chat (server/controller-approve.ts). controllerCanApprovePermits above stays a separate switch: it lets the
  // controller approve low risk permits on its own judgment, without the user's words.
  controllerApprovals: ControllerApprovals;
  // Settings > Agent errors (server/agent-error-watch.ts). autoContinue: type `message` into an agent that stopped on a
  // model error (overloaded, rate limit, server error, lost connection), after 1, 2, 5, 10 and 10 minutes, at most five
  // times for one error. accounts: 'on' or 'off' for one account; a task can set its own value (Task.autoContinue).
  // stallMinutes: a working task whose screen and transcript did not change for this time, while it waits for the
  // model, shows "Stalled" (0: never).
  agentErrors: AgentErrorSettings;
}
export interface AgentErrorSettings { autoContinue: boolean; message: string; stallMinutes: number; accounts: Record<string, 'on' | 'off'>; codexCapacity: { enabled: boolean; intervalSeconds: number; maxRetries: number } }
export interface PermitRequestLimits { enabled: boolean; tenMinutes: number; day: number }
export const DEFAULT_PERMIT_REQUEST_LIMITS: PermitRequestLimits = { enabled: true, tenMinutes: 5, day: 20 };
export function readPermitRequestLimits(saved: unknown): PermitRequestLimits {
  const s = saved && typeof saved === 'object' ? saved as Record<string, unknown> : {};
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : DEFAULT_PERMIT_REQUEST_LIMITS.enabled,
    tenMinutes: Number.isInteger(s.tenMinutes) && (s.tenMinutes as number) >= 1 && (s.tenMinutes as number) <= 1000 ? s.tenMinutes as number : DEFAULT_PERMIT_REQUEST_LIMITS.tenMinutes,
    day: Number.isInteger(s.day) && (s.day as number) >= 1 && (s.day as number) <= 1000 ? s.day as number : DEFAULT_PERMIT_REQUEST_LIMITS.day,
  };
}
export const DEFAULT_AGENT_ERRORS: AgentErrorSettings = { autoContinue: false, message: 'continue', stallMinutes: 5, accounts: {}, codexCapacity: { enabled: false, intervalSeconds: 60, maxRetries: 5 } };
export function readAgentErrors(saved: unknown): AgentErrorSettings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<AgentErrorSettings>;
  const accounts = Object.fromEntries(Object.entries(s.accounts && typeof s.accounts === 'object' ? s.accounts : {}).filter(([, v]) => v === 'on' || v === 'off')) as Record<string, 'on' | 'off'>;
  return {
    autoContinue: s.autoContinue === true,
    message: typeof s.message === 'string' && s.message.trim() ? s.message.trim().slice(0, 500) : DEFAULT_AGENT_ERRORS.message,
    stallMinutes: Number.isInteger(s.stallMinutes) && s.stallMinutes! >= 0 && s.stallMinutes! <= 240 ? s.stallMinutes! : DEFAULT_AGENT_ERRORS.stallMinutes,
    accounts,
    codexCapacity: {
      enabled: s.codexCapacity?.enabled === true,
      intervalSeconds: Number.isInteger(s.codexCapacity?.intervalSeconds) && s.codexCapacity!.intervalSeconds >= 5 && s.codexCapacity!.intervalSeconds <= 3600 ? s.codexCapacity!.intervalSeconds : 60,
      maxRetries: Number.isInteger(s.codexCapacity?.maxRetries) && s.codexCapacity!.maxRetries >= 1 && s.codexCapacity!.maxRetries <= 100 ? s.codexCapacity!.maxRetries : 5,
    },
  };
}
export type ControllerAgent = 'claude' | 'codex' | 'antigravity';
export const CONTROLLER_AGENTS: ControllerAgent[] = ['claude', 'codex', 'antigravity'];
export interface ControllerSettings {
  autostart: boolean; remoteControl: boolean; computerUse: boolean; agent: ControllerAgent;
  skipPermissions: Record<ControllerAgent, boolean>; accounts: Partial<Record<ControllerAgent, string>>;
  dangerouslySkipPermissions: boolean; models: Record<ControllerAgent, string>;
}
export const DEFAULT_CONTROLLER: ControllerSettings = { autostart: true, remoteControl: true, computerUse: true, agent: 'claude', skipPermissions: { claude: false, codex: false, antigravity: false }, accounts: {}, dangerouslySkipPermissions: false, models: { claude: 'claude-sonnet-5-5', codex: '', antigravity: '' } };
// A saved controller value. A file written before Settings > Controller agent has no agent: then agentSaved is false,
// and the server takes the agent of the running controller task (index.ts), so an update switches nothing.
// The older dangerouslySkipPermissions (Claude Code only) becomes skipPermissions.claude. Codex and Antigravity start off.
export function readController(saved: unknown): { controller: ControllerSettings; agentSaved: boolean } {
  const s = saved && typeof saved === 'object' ? saved as Record<string, any> : {};
  const agentSaved = CONTROLLER_AGENTS.includes(s.agent);
  const skip = s.skipPermissions && typeof s.skipPermissions === 'object' ? s.skipPermissions : {};
  const skipPermissions = { ...DEFAULT_CONTROLLER.skipPermissions };
  for (const a of CONTROLLER_AGENTS) if (typeof skip[a] === 'boolean') skipPermissions[a] = skip[a];
  if (typeof skip.claude !== 'boolean' && typeof s.dangerouslySkipPermissions === 'boolean') skipPermissions.claude = s.dangerouslySkipPermissions;
  const acc = s.accounts && typeof s.accounts === 'object' ? s.accounts : {};
  const accounts: ControllerSettings['accounts'] = {};
  for (const a of CONTROLLER_AGENTS) if (typeof acc[a] === 'string' && acc[a]) accounts[a] = acc[a];
  const models = { ...DEFAULT_CONTROLLER.models };
  for (const a of CONTROLLER_AGENTS) if (typeof s.models?.[a] === 'string') models[a] = s.models[a];
  return { agentSaved, controller: {
    autostart: typeof s.autostart === 'boolean' ? s.autostart : DEFAULT_CONTROLLER.autostart,
    remoteControl: typeof s.remoteControl === 'boolean' ? s.remoteControl : DEFAULT_CONTROLLER.remoteControl,
    computerUse: typeof s.computerUse === 'boolean' ? s.computerUse : DEFAULT_CONTROLLER.computerUse,
    agent: agentSaved ? s.agent : 'claude', skipPermissions, accounts, dangerouslySkipPermissions: skipPermissions.claude, models,
  } };
}
export interface ControllerApprovals { merge: boolean; push: boolean; forcePush: boolean; release: boolean; restart: boolean; scope: boolean; permit: boolean; mail: boolean }
// All on: the user asked for this. Force push, release, restart and message drafts have extra checks (controller-approve.ts extraRules).
export const DEFAULT_CONTROLLER_APPROVALS: ControllerApprovals = { merge: true, push: true, forcePush: true, release: true, restart: true, scope: true, permit: true, mail: true };
export function readControllerApprovals(saved: unknown): ControllerApprovals {
  const s = saved && typeof saved === 'object' ? saved as Record<string, unknown> : {};
  const out = { ...DEFAULT_CONTROLLER_APPROVALS };
  for (const k of Object.keys(out) as (keyof ControllerApprovals)[]) if (typeof s[k] === 'boolean') out[k] = s[k] as boolean;
  return out;
}
export interface ClaudeInChrome { tasks: boolean; controller: boolean }
// a saved claudeInChrome value: each missing or invalid field is false (a file written before this setting has none,
// and the earlier browser mode "task" then gave tasks Claude in Chrome; such a file now gets Off)
export function readClaudeInChrome(saved: unknown): ClaudeInChrome {
  const s = saved && typeof saved === 'object' ? saved as Record<string, unknown> : {};
  return { tasks: s.tasks === true, controller: s.controller === true };
}
export interface ConfirmRisk { wideAccess: boolean; installs: boolean; spends: boolean; exits: boolean }
export const DEFAULT_CONFIRM_RISK: ConfirmRisk = { wideAccess: false, installs: true, spends: true, exits: true };
// a saved confirmRisk value: each missing or invalid field gets its default (a file written before this setting has none)
export function readConfirmRisk(saved: unknown): ConfirmRisk {
  const s = saved && typeof saved === 'object' ? saved as Record<string, unknown> : {};
  const out = { ...DEFAULT_CONFIRM_RISK };
  for (const k of Object.keys(out) as (keyof ConfirmRisk)[]) if (typeof s[k] === 'boolean') out[k] = s[k] as boolean;
  return out;
}

const FILE = join(TB_DIR, 'machine.json');

// macOS local host name ("Marios-MacBook-Pro"), else the host name without its domain
function defaultName() {
  try { const n = execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim(); if (n) return n; } catch { /* not macOS */ }
  return hostname().split('.')[0];
}

export const DEFAULT_ROUTING_RULES = `Use Claude Code or Codex for deep planning and hard coding work.
Use Antigravity for routine work. Do not use it for deep planning.
When Claude's usage is high, use Codex for deep planning.
Avoid accounts at their limit or running their maximum number of tasks.`;
let settings: MachineSettings = { name: process.env.TASKBOARD_MACHINE_NAME || defaultName(), routingRules: DEFAULT_ROUTING_RULES, newTaskDefaultAgent: 'claude', controller: structuredClone(DEFAULT_CONTROLLER), permissions: { controllerNeedsApproval: false, agentsNeedApproval: true, allTaskCommunication: false, trustWorkspaces: true, autoReview: true, controllerCanApprovePermits: false, holdPermissionHook: true }, permitFolders: [], permitRequestLimits: { ...DEFAULT_PERMIT_REQUEST_LIMITS }, pushes: { taskBranches: 'run', ownRepositories: [], protectedBranches: [] }, ask: { agent: 'claude', account: 'claude-default', model: 'sonnet' }, review: { account: 'claude-default', model: 'sonnet' }, accounts: { defaultMaxParallel: 4 }, browser: { claude: 'task', codex: 'task', chromePath: '', idleStopMinutes: 10, sharp: false, scale: 'screen', autoSwitch: true }, claudeInChrome: { tasks: false, controller: false }, confirmRisk: { ...DEFAULT_CONFIRM_RISK }, a2aNotes: { slackClientId: '', slackTeamId: '' }, controllerApprovals: { ...DEFAULT_CONTROLLER_APPROVALS }, agentErrors: readAgentErrors(undefined) };
export type BrowserScale = 'screen' | 'one' | 'two';
const SCALES: BrowserScale[] = ['screen', 'one', 'two'];
function readScale(b: { scale?: unknown; sharp?: unknown } | undefined): BrowserScale {
  if (SCALES.includes(b?.scale as BrowserScale)) return b!.scale as BrowserScale;
  return b?.sharp === true ? 'two' : 'screen';
}
// false when machine.json names no controller agent (see readController); adoptControllerAgent sets it
let controllerAgentSaved = true;
if (existsSync(FILE)) {
  const saved = JSON.parse(readFileSync(FILE, 'utf8'));
  const c = readController(saved.controller); controllerAgentSaved = c.agentSaved;
  settings = { ...settings, ...saved, permitFolders: Array.isArray(saved.permitFolders) ? saved.permitFolders : [], permitRequestLimits: readPermitRequestLimits(saved.permitRequestLimits), pushes: { ...settings.pushes, ...saved.pushes }, controller: c.controller, permissions: { ...settings.permissions, ...saved.permissions, allTaskCommunication: saved.permissions?.allTaskCommunication === true }, ask: { ...settings.ask, ...saved.ask }, review: { ...settings.review, ...saved.review }, accounts: { ...settings.accounts, ...saved.accounts }, browser: { ...settings.browser, ...saved.browser, scale: readScale(saved.browser) }, claudeInChrome: readClaudeInChrome(saved.claudeInChrome), confirmRisk: readConfirmRisk(saved.confirmRisk), a2aNotes: { ...settings.a2aNotes, ...saved.a2aNotes }, controllerApprovals: readControllerApprovals(saved.controllerApprovals), agentErrors: readAgentErrors(saved.agentErrors) };
} else writeFileSync(FILE, JSON.stringify(settings, null, 2));

export const get = () => settings;
export const controllerAgentKnown = () => controllerAgentSaved;
// After an update from a release without the setting: the agent that the controller task runs now.
export function adoptControllerAgent(agent: ControllerAgent, account?: string) {
  if (controllerAgentSaved || !CONTROLLER_AGENTS.includes(agent)) return;
  settings.controller.agent = agent;
  if (account) settings.controller.accounts[agent] = account;
  controllerAgentSaved = true;
  writeFileSync(FILE, JSON.stringify(settings, null, 2));
}
// Settings > Controller agent, or a controller account of another agent on the Accounts page (agents.setControllerAgent)
// previous: the agent and account that ran before, kept so that a switch back uses the same account again
export function setControllerAgent(agent: ControllerAgent, account: string, previous?: { agent: ControllerAgent; account: string }) {
  if (!CONTROLLER_AGENTS.includes(agent)) throw new Error('Choose Claude Code, Codex or Antigravity for the controller.');
  if (previous && CONTROLLER_AGENTS.includes(previous.agent)) settings.controller.accounts[previous.agent] = previous.account;
  settings.controller.agent = agent;
  settings.controller.accounts[agent] = account;
  controllerAgentSaved = true;
  writeFileSync(FILE, JSON.stringify(settings, null, 2));
}
export function checkMaxParallel(value: unknown): number {
  const n = Number(value);
  if (value === '' || value === null || !Number.isInteger(n) || n < 1 || n > 100) throw new Error('The maximum number of tasks must be a whole number from 1 to 100.');
  return n;
}
export const controllerLabel = () => `Taskboard controller · ${settings.name}`;
export function update(patch: { name?: string; routingRules?: string; newTaskDefaultAgent?: MachineSettings['newTaskDefaultAgent']; autostart?: boolean; remoteControl?: boolean; controllerComputerUse?: boolean; dangerouslySkipPermissions?: boolean; controllerSkipPermissions?: Partial<Record<ControllerAgent, boolean>>; controllerModels?: Partial<Record<'claude' | 'codex' | 'antigravity', string>>; controllerNeedsApproval?: boolean; agentsNeedApproval?: boolean; allTaskCommunication?: boolean; trustWorkspaces?: boolean; autoReview?: boolean; controllerCanApprovePermits?: boolean; holdPermissionHook?: boolean; permitFolders?: string[]; permitRequestLimits?: Partial<PermitRequestLimits>; pushTaskBranches?: 'run' | 'ask' | 'never'; ownRepositories?: string[]; protectedBranches?: string[]; askAgent?: 'claude' | 'codex'; askAccount?: string; askModel?: string; reviewAccount?: string; reviewModel?: string; defaultMaxParallel?: number; browserClaude?: BrowserMode; browserCodex?: BrowserMode; chromePath?: string; browserIdleStopMinutes?: number; browserSharp?: boolean; browserScale?: BrowserScale; browserAutoSwitch?: boolean; claudeInChromeTasks?: boolean; claudeInChromeController?: boolean; confirmRisk?: Partial<ConfirmRisk>; a2aSlackClientId?: string; a2aSlackTeamId?: string; controllerApprovals?: Partial<ControllerApprovals>; agentErrors?: Partial<AgentErrorSettings> }) {
  if (patch.permitRequestLimits !== undefined) {
    const limits = patch.permitRequestLimits as Record<string, unknown> | null;
    if (!limits || typeof limits !== 'object' || Array.isArray(limits) || Object.entries(limits).some(([key, value]) =>
      key === 'enabled' ? typeof value !== 'boolean' : !['tenMinutes', 'day'].includes(key) || !Number.isInteger(value) || (value as number) < 1 || (value as number) > 1000))
      throw new Error('Permit request limits need on or off and whole numbers from 1 to 1000.');
    settings.permitRequestLimits = { ...settings.permitRequestLimits, ...limits as Partial<PermitRequestLimits> };
  }
  if (patch.routingRules !== undefined) {
    if (typeof patch.routingRules !== 'string') throw new Error('routingRules must be text.');
    settings.routingRules = patch.routingRules.trim().slice(0, 1000);
  }
  if (patch.newTaskDefaultAgent !== undefined) {
    if (!['auto', 'claude', 'codex', 'antigravity'].includes(patch.newTaskDefaultAgent)) throw new Error('Choose Auto or a fixed agent for new tasks.');
    settings.newTaskDefaultAgent = patch.newTaskDefaultAgent;
  }
  if (patch.controllerNeedsApproval !== undefined) settings.permissions.controllerNeedsApproval = !!patch.controllerNeedsApproval;
  if (patch.agentsNeedApproval !== undefined) settings.permissions.agentsNeedApproval = !!patch.agentsNeedApproval;
  if (patch.allTaskCommunication !== undefined) {
    if (typeof patch.allTaskCommunication !== 'boolean') throw new Error('allTaskCommunication must be true or false.');
    settings.permissions.allTaskCommunication = patch.allTaskCommunication;
  }
  if (patch.trustWorkspaces !== undefined) settings.permissions.trustWorkspaces = !!patch.trustWorkspaces;
  if (patch.autoReview !== undefined) settings.permissions.autoReview = !!patch.autoReview;
  if (patch.controllerCanApprovePermits !== undefined) settings.permissions.controllerCanApprovePermits = !!patch.controllerCanApprovePermits;
  if (patch.holdPermissionHook !== undefined) settings.permissions.holdPermissionHook = !!patch.holdPermissionHook;
  if (patch.confirmRisk !== undefined) {
    const c = patch.confirmRisk as Record<string, unknown> | null;
    if (!c || typeof c !== 'object' || Array.isArray(c) || Object.entries(c).some(([k, v]) => !(k in DEFAULT_CONFIRM_RISK) || typeof v !== 'boolean')) throw new Error('confirmRisk takes wideAccess, installs, spends and exits, each true or false.');
    settings.confirmRisk = { ...settings.confirmRisk, ...c as Partial<ConfirmRisk> };
  }
  if (patch.controllerApprovals !== undefined) {
    const c = patch.controllerApprovals as Record<string, unknown> | null;
    if (!c || typeof c !== 'object' || Array.isArray(c) || Object.entries(c).some(([k, v]) => !(k in DEFAULT_CONTROLLER_APPROVALS) || typeof v !== 'boolean')) throw new Error(`controllerApprovals takes ${Object.keys(DEFAULT_CONTROLLER_APPROVALS).join(', ')}, each true or false.`);
    settings.controllerApprovals = { ...settings.controllerApprovals, ...c as Partial<ControllerApprovals> };
  }
  if (patch.pushTaskBranches !== undefined) {
    if (!['run', 'ask', 'never'].includes(patch.pushTaskBranches)) throw new Error('Choose run, ask, or never for task branch pushes.');
    settings.pushes.taskBranches = patch.pushTaskBranches;
  }
  for (const [field, values] of [['ownRepositories', patch.ownRepositories], ['protectedBranches', patch.protectedBranches]] as const) {
    if (values === undefined) continue;
    const pattern = field === 'ownRepositories' ? /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/ : /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
    if (!Array.isArray(values) || values.length > 100 || values.some(v => typeof v !== 'string' || !pattern.test(v))) throw new Error(`Invalid ${field}.`);
    settings.pushes[field] = values;
  }
  if (patch.permitFolders !== undefined) {
    if (!Array.isArray(patch.permitFolders) || patch.permitFolders.length > 8 || patch.permitFolders.some(p => typeof p !== 'string' || !p.startsWith('/') || p.length > 500 || !existsSync(p) || !statSync(p).isDirectory())) throw new Error('Give up to eight existing absolute folder paths.');
    const roots = patch.permitFolders.map(p => realpathSync(p));
    if (roots.some(root => [TB_DIR, TASKS_DIR].some(protectedPath => {
      const protectedRoot = realpathSync(protectedPath);
      return root === protectedRoot || protectedRoot.startsWith(root + '/') || root.startsWith(protectedRoot + '/');
    }))) throw new Error('An extra folder cannot include Taskboard files or another task vault.');
    settings.permitFolders = roots;
  }
  if (patch.defaultMaxParallel !== undefined) settings.accounts.defaultMaxParallel = checkMaxParallel(patch.defaultMaxParallel);
  if (patch.name !== undefined && patch.name.trim()) settings.name = patch.name.trim().slice(0, 40);
  if (patch.autostart !== undefined) settings.controller.autostart = !!patch.autostart;
  if (patch.remoteControl !== undefined) settings.controller.remoteControl = !!patch.remoteControl;
  if (patch.controllerComputerUse !== undefined) {
    if (typeof patch.controllerComputerUse !== 'boolean') throw new Error('controllerComputerUse must be true or false.');
    settings.controller.computerUse = patch.controllerComputerUse;
  }
  // the older name of the Claude Code switch, from an older dashboard page
  if (patch.dangerouslySkipPermissions !== undefined) {
    if (typeof patch.dangerouslySkipPermissions !== 'boolean') throw new Error('The controller permission setting must be on or off.');
    settings.controller.skipPermissions.claude = patch.dangerouslySkipPermissions;
  }
  if (patch.controllerSkipPermissions !== undefined) {
    const c = patch.controllerSkipPermissions as Record<string, unknown> | null;
    if (!c || typeof c !== 'object' || Array.isArray(c) || Object.entries(c).some(([k, v]) => !CONTROLLER_AGENTS.includes(k as ControllerAgent) || typeof v !== 'boolean')) throw new Error('controllerSkipPermissions takes claude, codex and antigravity, each true or false.');
    Object.assign(settings.controller.skipPermissions, c);
  }
  settings.controller.dangerouslySkipPermissions = settings.controller.skipPermissions.claude;
  if (patch.controllerModels !== undefined) {
    if (!patch.controllerModels || typeof patch.controllerModels !== 'object' || Array.isArray(patch.controllerModels)) throw new Error('controllerModels must be an object.');
    for (const [agent, model] of Object.entries(patch.controllerModels)) {
      if (!['claude', 'codex', 'antigravity'].includes(agent) || typeof model !== 'string' || (model && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(model))) throw new Error('Pick a valid controller model.');
    }
    Object.assign(settings.controller.models, patch.controllerModels);
  }
  if (patch.askAgent && patch.askAgent !== settings.ask.agent) {
    settings.ask = patch.askAgent === 'claude'
      ? { agent: 'claude', account: 'claude-default', model: 'sonnet' }
      : { agent: 'codex', account: 'codex-default', model: 'gpt-5.6-sol' };
  }
  if (patch.askAccount) settings.ask.account = patch.askAccount;
  if (patch.askModel) settings.ask.model = patch.askModel;
  if (patch.reviewAccount) settings.review.account = patch.reviewAccount;
  if (patch.reviewModel && ['sonnet', 'opus'].includes(patch.reviewModel)) settings.review.model = patch.reviewModel;
  for (const [agent, mode] of [['claude', patch.browserClaude], ['codex', patch.browserCodex]] as const) {
    if (mode === undefined) continue;
    if (!['off', 'task', 'only'].includes(mode)) throw new Error('Choose off, task, or only for the task browser.');
    settings.browser[agent] = mode;
  }
  if (patch.chromePath !== undefined) {
    if (typeof patch.chromePath !== 'string' || (patch.chromePath && (!patch.chromePath.startsWith('/') || !existsSync(patch.chromePath) || !statSync(patch.chromePath).isFile()))) throw new Error('Give the absolute path of the Chrome program, or leave it empty.');
    settings.browser.chromePath = patch.chromePath;
  }
  if (patch.browserIdleStopMinutes !== undefined) {
    const n = Number(patch.browserIdleStopMinutes);
    if (!Number.isFinite(n) || n < 0 || n > 1440) throw new Error('Give the idle time of a task browser in minutes, from 0 (never stop) to 1440.');
    settings.browser.idleStopMinutes = n;
  }
  // the older switch: on is two pixels for each point, off follows the screen
  if (patch.browserSharp !== undefined) { settings.browser.sharp = !!patch.browserSharp; settings.browser.scale = patch.browserSharp ? 'two' : 'screen'; }
  if (patch.browserScale !== undefined) {
    if (!SCALES.includes(patch.browserScale)) throw new Error("The browser scale must be 'screen', 'one' or 'two'.");
    settings.browser.scale = patch.browserScale;
  }
  if (patch.browserAutoSwitch !== undefined) settings.browser.autoSwitch = !!patch.browserAutoSwitch;
  if (patch.claudeInChromeTasks !== undefined) settings.claudeInChrome.tasks = patch.claudeInChromeTasks === true;
  if (patch.claudeInChromeController !== undefined) settings.claudeInChrome.controller = patch.claudeInChromeController === true;
  // the same patterns as server/a2anotes/slack-app.ts CLIENT_ID_PATTERN and TEAM_ID_PATTERN; empty clears the setting
  if (patch.a2aSlackClientId !== undefined) {
    if (typeof patch.a2aSlackClientId !== 'string' || (patch.a2aSlackClientId.trim() && !/^\d{6,20}\.\d{6,20}$/.test(patch.a2aSlackClientId.trim()))) throw new Error('Give a Slack client ID such as 8696283833057.12198817279122, or leave it empty.');
    settings.a2aNotes.slackClientId = patch.a2aSlackClientId.trim();
  }
  if (patch.agentErrors !== undefined) {
    const a = patch.agentErrors as Record<string, unknown> | null;
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('agentErrors must be an object.');
    if (a.autoContinue !== undefined && typeof a.autoContinue !== 'boolean') throw new Error('Auto-continue must be on or off.');
    if (a.message !== undefined && (typeof a.message !== 'string' || !a.message.trim() || a.message.length > 500 || /[\r\n]/.test(a.message))) throw new Error('The auto-continue message must be one line of 1 to 500 characters.');
    if (a.stallMinutes !== undefined && !(Number.isInteger(a.stallMinutes) && (a.stallMinutes as number) >= 0 && (a.stallMinutes as number) <= 240)) throw new Error('The stall time must be a whole number of minutes from 0 (never) to 240.');
    const capacity = a.codexCapacity as Record<string, unknown> | undefined;
    if (capacity !== undefined && (!capacity || typeof capacity !== 'object' || Array.isArray(capacity))) throw new Error('Codex capacity settings must be an object.');
    if (capacity?.enabled !== undefined && typeof capacity.enabled !== 'boolean') throw new Error('Codex capacity retry must be on or off.');
    if (capacity?.intervalSeconds !== undefined && !(Number.isInteger(capacity.intervalSeconds) && (capacity.intervalSeconds as number) >= 5 && (capacity.intervalSeconds as number) <= 3600)) throw new Error('The retry interval must be 5 to 3600 seconds.');
    if (capacity?.maxRetries !== undefined && !(Number.isInteger(capacity.maxRetries) && (capacity.maxRetries as number) >= 1 && (capacity.maxRetries as number) <= 100)) throw new Error('The retry count must be 1 to 100.');
    if (a.accounts !== undefined && (!a.accounts || typeof a.accounts !== 'object' || Object.values(a.accounts).some(v => !['on', 'off', 'default'].includes(v as string)))) throw new Error('Each account takes on, off or default.');
    const accounts = { ...settings.agentErrors.accounts };
    for (const [id, v] of Object.entries((a.accounts || {}) as Record<string, string>)) { if (v === 'default') delete accounts[id]; else accounts[id] = v as 'on' | 'off'; }
    settings.agentErrors = { ...settings.agentErrors, ...(a.autoContinue !== undefined ? { autoContinue: a.autoContinue as boolean } : {}), ...(a.message !== undefined ? { message: (a.message as string).trim() } : {}), ...(a.stallMinutes !== undefined ? { stallMinutes: a.stallMinutes as number } : {}), accounts, codexCapacity: { ...settings.agentErrors.codexCapacity, ...capacity } };
  }
  if (patch.a2aSlackTeamId !== undefined) {
    if (typeof patch.a2aSlackTeamId !== 'string' || (patch.a2aSlackTeamId.trim() && !/^T[A-Z0-9]{6,20}$/.test(patch.a2aSlackTeamId.trim()))) throw new Error('Give a Slack team ID such as T08LG8BQH1P, or leave it empty.');
    settings.a2aNotes.slackTeamId = patch.a2aSlackTeamId.trim();
  }
  writeFileSync(FILE, JSON.stringify(settings, null, 2));
  return settings;
}
