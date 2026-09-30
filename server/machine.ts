// This machine's identity and the controller settings, in ~/.taskboard/machine.json.
// The name tells you which machine a controller or a Taskboard server belongs to (for example in the Claude mobile app,
// where the controller's Remote Control session is called "Taskboard controller · <name>").
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { TB_DIR, TASKS_DIR } from './config.ts';

export interface MachineSettings {
  name: string;
  routingRules: string;
  newTaskDefaultAgent: 'auto' | 'claude' | 'codex' | 'antigravity';
  controller: { autostart: boolean; remoteControl: boolean; dangerouslySkipPermissions: boolean; models: Record<'claude' | 'codex' | 'antigravity', string> };
  // actions through `tb` that act on other tasks (new, send, set aside, archive): run at once, or wait for Approve
  permissions: { controllerNeedsApproval: boolean; agentsNeedApproval: boolean; trustWorkspaces: boolean; autoReview: boolean; controllerCanApprovePermits: boolean };
  permitFolders: string[];
  pushes: { taskBranches: 'run' | 'ask' | 'never'; ownRepositories: string[]; protectedBranches: string[] };
  // questions about a task (server/ask.ts): the separate agent, account, and model
  ask: { agent: 'claude' | 'codex'; account: string; model: string };
  review: { account: string; model: string };
  // messages between Taskboard users (server/mail/policy.ts): 1 the user approves every message, 2 the controller approves
  // messages that pass the check, 3 the controller also approves messages the check is unsure about
  messages: { incoming: 1 | 2 | 3; outgoing: 1 | 2 | 3; checkPrivateNotes: boolean };
  // the maximum number of running tasks for an account added later (server/accounts.ts create); the default accounts
  // keep their own maximum until the user applies this value to all accounts
  accounts: { defaultMaxParallel: number };
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
let settings: MachineSettings = { name: process.env.TASKBOARD_MACHINE_NAME || defaultName(), routingRules: DEFAULT_ROUTING_RULES, newTaskDefaultAgent: 'claude', controller: { autostart: true, remoteControl: true, dangerouslySkipPermissions: true, models: { claude: 'claude-sonnet-5-5', codex: '', antigravity: '' } }, permissions: { controllerNeedsApproval: false, agentsNeedApproval: true, trustWorkspaces: true, autoReview: true, controllerCanApprovePermits: false }, permitFolders: [], pushes: { taskBranches: 'run', ownRepositories: [], protectedBranches: [] }, ask: { agent: 'claude', account: 'claude-default', model: 'sonnet' }, review: { account: 'claude-default', model: 'sonnet' }, messages: { incoming: 2, outgoing: 2, checkPrivateNotes: true }, accounts: { defaultMaxParallel: 4 } };
if (existsSync(FILE)) {
  const saved = JSON.parse(readFileSync(FILE, 'utf8'));
  // Before the levels, the Inbox checkbox "Allow my controller to approve ordinary communication" (mail.json
  // controllerApproval) decided outgoing approval. When it was off, keep the user in charge of every send.
  let messages = saved.messages;
  if (!messages) {
    try { messages = { incoming: 2, outgoing: JSON.parse(readFileSync(join(TB_DIR, 'mail.json'), 'utf8')).controllerApproval === false ? 1 : 2 }; } catch { /* no mailbox yet */ }
  }
  settings = { ...settings, ...saved, permitFolders: Array.isArray(saved.permitFolders) ? saved.permitFolders : [], pushes: { ...settings.pushes, ...saved.pushes }, messages: { ...settings.messages, ...messages }, controller: { ...settings.controller, ...saved.controller, models: { ...settings.controller.models, ...saved.controller?.models } }, permissions: { ...settings.permissions, ...saved.permissions }, ask: { ...settings.ask, ...saved.ask }, review: { ...settings.review, ...saved.review }, accounts: { ...settings.accounts, ...saved.accounts } };
  if (!saved.messages) writeFileSync(FILE, JSON.stringify(settings, null, 2)); // keep the migrated levels
} else writeFileSync(FILE, JSON.stringify(settings, null, 2));

export const get = () => settings;
export function checkMaxParallel(value: unknown): number {
  const n = Number(value);
  if (value === '' || value === null || !Number.isInteger(n) || n < 1 || n > 100) throw new Error('The maximum number of tasks must be a whole number from 1 to 100.');
  return n;
}
export const controllerLabel = () => `Taskboard controller · ${settings.name}`;
export function update(patch: { name?: string; routingRules?: string; newTaskDefaultAgent?: MachineSettings['newTaskDefaultAgent']; autostart?: boolean; remoteControl?: boolean; dangerouslySkipPermissions?: boolean; controllerModels?: Partial<Record<'claude' | 'codex' | 'antigravity', string>>; controllerNeedsApproval?: boolean; agentsNeedApproval?: boolean; trustWorkspaces?: boolean; autoReview?: boolean; controllerCanApprovePermits?: boolean; permitFolders?: string[]; pushTaskBranches?: 'run' | 'ask' | 'never'; ownRepositories?: string[]; protectedBranches?: string[]; askAgent?: 'claude' | 'codex'; askAccount?: string; askModel?: string; reviewAccount?: string; reviewModel?: string; messageIncoming?: number; messageOutgoing?: number; checkPrivateNotes?: boolean; defaultMaxParallel?: number }) {
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
  for (const [key, value] of [['incoming', patch.messageIncoming], ['outgoing', patch.messageOutgoing]] as const) {
    if (value === undefined) continue;
    if (value !== 1 && value !== 2 && value !== 3) throw new Error('A message level must be 1, 2 or 3.');
    settings.messages[key] = value;
  }
  if (patch.checkPrivateNotes !== undefined) {
    if (typeof patch.checkPrivateNotes !== 'boolean') throw new Error('The message check setting must be on or off.');
    settings.messages.checkPrivateNotes = patch.checkPrivateNotes;
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
  writeFileSync(FILE, JSON.stringify(settings, null, 2));
  return settings;
}
