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
  controller: { autostart: boolean; remoteControl: boolean; dangerouslySkipPermissions: boolean; models: Record<'claude' | 'codex' | 'antigravity', string> };
  // actions through `tb` that act on other tasks (new, send, set aside, archive): run at once, or wait for Approve
  permissions: { controllerNeedsApproval: boolean; agentsNeedApproval: boolean; trustWorkspaces: boolean; autoReview: boolean; controllerCanApprovePermits: boolean; holdPermissionHook: boolean };
  permitFolders: string[];
  pushes: { taskBranches: 'run' | 'ask' | 'never'; ownRepositories: string[]; protectedBranches: string[] };
  // questions about a task (server/ask.ts): the separate agent, account, and model
  ask: { agent: 'claude' | 'codex'; account: string; model: string };
  review: { account: string; model: string };
  // the maximum number of running tasks for an account added later (server/accounts.ts create); the default accounts
  // keep their own maximum until the user applies this value to all accounts
  accounts: { defaultMaxParallel: number };
  // the browser for each task (server/task-browser.ts); chromePath empty means the installed Google Chrome;
  // idleStopMinutes: a task browser without an agent command or a viewer for this time stops (0: never)
  // sharp: task browsers start with --force-device-scale-factor=2, so the dashboard view gets frames with two pixels
  // for each CSS pixel (sharp text on a Retina screen). Agent screenshots are then twice as large too.
  browser: { claude: BrowserMode; codex: BrowserMode; chromePath: string; idleStopMinutes: number; sharp: boolean };
  // Claude in Chrome (the Claude extension in the user's own Chrome) for Claude Code sessions that Taskboard starts.
  // false: the command has --no-chrome, so Claude Code does not show the dialog "Claude in Chrome extension detected"
  // at start. true: Claude Code decides, and can show that dialog once.
  claudeInChrome: ClaudeInChrome;
  // the second confirm step on a card option with a risk (server/pending.ts answer, web PendingCard): true shows the
  // step, false sends the click at once. The controller never chooses such an option (pending.controllerRule).
  confirmRisk: ConfirmRisk;
  // the Slack app that A2A Notes setup uses (server/a2anotes/slack-app.ts); empty means the environment or the default
  a2aNotes: { slackClientId: string; slackTeamId: string };
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
let settings: MachineSettings = { name: process.env.TASKBOARD_MACHINE_NAME || defaultName(), routingRules: DEFAULT_ROUTING_RULES, newTaskDefaultAgent: 'claude', controller: { autostart: true, remoteControl: true, dangerouslySkipPermissions: true, models: { claude: 'claude-sonnet-5-5', codex: '', antigravity: '' } }, permissions: { controllerNeedsApproval: false, agentsNeedApproval: true, trustWorkspaces: true, autoReview: true, controllerCanApprovePermits: false, holdPermissionHook: true }, permitFolders: [], pushes: { taskBranches: 'run', ownRepositories: [], protectedBranches: [] }, ask: { agent: 'claude', account: 'claude-default', model: 'sonnet' }, review: { account: 'claude-default', model: 'sonnet' }, accounts: { defaultMaxParallel: 4 }, browser: { claude: 'task', codex: 'task', chromePath: '', idleStopMinutes: 10, sharp: false }, claudeInChrome: { tasks: false, controller: false }, confirmRisk: { ...DEFAULT_CONFIRM_RISK }, a2aNotes: { slackClientId: '', slackTeamId: '' } };
if (existsSync(FILE)) {
  const saved = JSON.parse(readFileSync(FILE, 'utf8'));
  settings = { ...settings, ...saved, permitFolders: Array.isArray(saved.permitFolders) ? saved.permitFolders : [], pushes: { ...settings.pushes, ...saved.pushes }, controller: { ...settings.controller, ...saved.controller, models: { ...settings.controller.models, ...saved.controller?.models } }, permissions: { ...settings.permissions, ...saved.permissions }, ask: { ...settings.ask, ...saved.ask }, review: { ...settings.review, ...saved.review }, accounts: { ...settings.accounts, ...saved.accounts }, browser: { ...settings.browser, ...saved.browser }, claudeInChrome: readClaudeInChrome(saved.claudeInChrome), confirmRisk: readConfirmRisk(saved.confirmRisk), a2aNotes: { ...settings.a2aNotes, ...saved.a2aNotes } };
} else writeFileSync(FILE, JSON.stringify(settings, null, 2));

export const get = () => settings;
export function checkMaxParallel(value: unknown): number {
  const n = Number(value);
  if (value === '' || value === null || !Number.isInteger(n) || n < 1 || n > 100) throw new Error('The maximum number of tasks must be a whole number from 1 to 100.');
  return n;
}
export const controllerLabel = () => `Taskboard controller · ${settings.name}`;
export function update(patch: { name?: string; routingRules?: string; newTaskDefaultAgent?: MachineSettings['newTaskDefaultAgent']; autostart?: boolean; remoteControl?: boolean; dangerouslySkipPermissions?: boolean; controllerModels?: Partial<Record<'claude' | 'codex' | 'antigravity', string>>; controllerNeedsApproval?: boolean; agentsNeedApproval?: boolean; trustWorkspaces?: boolean; autoReview?: boolean; controllerCanApprovePermits?: boolean; holdPermissionHook?: boolean; permitFolders?: string[]; pushTaskBranches?: 'run' | 'ask' | 'never'; ownRepositories?: string[]; protectedBranches?: string[]; askAgent?: 'claude' | 'codex'; askAccount?: string; askModel?: string; reviewAccount?: string; reviewModel?: string; defaultMaxParallel?: number; browserClaude?: BrowserMode; browserCodex?: BrowserMode; chromePath?: string; browserIdleStopMinutes?: number; browserSharp?: boolean; claudeInChromeTasks?: boolean; claudeInChromeController?: boolean; confirmRisk?: Partial<ConfirmRisk>; a2aSlackClientId?: string; a2aSlackTeamId?: string }) {
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
  if (patch.trustWorkspaces !== undefined) settings.permissions.trustWorkspaces = !!patch.trustWorkspaces;
  if (patch.autoReview !== undefined) settings.permissions.autoReview = !!patch.autoReview;
  if (patch.controllerCanApprovePermits !== undefined) settings.permissions.controllerCanApprovePermits = !!patch.controllerCanApprovePermits;
  if (patch.holdPermissionHook !== undefined) settings.permissions.holdPermissionHook = !!patch.holdPermissionHook;
  if (patch.confirmRisk !== undefined) {
    const c = patch.confirmRisk as Record<string, unknown> | null;
    if (!c || typeof c !== 'object' || Array.isArray(c) || Object.entries(c).some(([k, v]) => !(k in DEFAULT_CONFIRM_RISK) || typeof v !== 'boolean')) throw new Error('confirmRisk takes wideAccess, installs, spends and exits, each true or false.');
    settings.confirmRisk = { ...settings.confirmRisk, ...c as Partial<ConfirmRisk> };
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
  if (patch.dangerouslySkipPermissions !== undefined) {
    if (typeof patch.dangerouslySkipPermissions !== 'boolean') throw new Error('The controller permission setting must be on or off.');
    settings.controller.dangerouslySkipPermissions = patch.dangerouslySkipPermissions;
  }
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
  if (patch.browserSharp !== undefined) settings.browser.sharp = !!patch.browserSharp;
  if (patch.claudeInChromeTasks !== undefined) settings.claudeInChrome.tasks = patch.claudeInChromeTasks === true;
  if (patch.claudeInChromeController !== undefined) settings.claudeInChrome.controller = patch.claudeInChromeController === true;
  // the same patterns as server/a2anotes/slack-app.ts CLIENT_ID_PATTERN and TEAM_ID_PATTERN; empty clears the setting
  if (patch.a2aSlackClientId !== undefined) {
    if (typeof patch.a2aSlackClientId !== 'string' || (patch.a2aSlackClientId.trim() && !/^\d{6,20}\.\d{6,20}$/.test(patch.a2aSlackClientId.trim()))) throw new Error('Give a Slack client ID such as 8696283833057.12198817279122, or leave it empty.');
    settings.a2aNotes.slackClientId = patch.a2aSlackClientId.trim();
  }
  if (patch.a2aSlackTeamId !== undefined) {
    if (typeof patch.a2aSlackTeamId !== 'string' || (patch.a2aSlackTeamId.trim() && !/^T[A-Z0-9]{6,20}$/.test(patch.a2aSlackTeamId.trim()))) throw new Error('Give a Slack team ID such as T08LG8BQH1P, or leave it empty.');
    settings.a2aNotes.slackTeamId = patch.a2aSlackTeamId.trim();
  }
  writeFileSync(FILE, JSON.stringify(settings, null, 2));
  return settings;
}
