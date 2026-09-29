// This machine's identity and the controller settings, in ~/.taskboard/machine.json.
// The name tells you which machine a controller or a Taskboard server belongs to (for example in the Claude mobile app,
// where the controller's Remote Control session is called "Taskboard controller · <name>").
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { TB_DIR } from './config.ts';

export interface MachineSettings {
  name: string;
  routingRules: string;
  controller: { autostart: boolean; remoteControl: boolean };
  // actions through `tb` that act on other tasks (new, send, set aside, archive): run at once, or wait for Approve
  permissions: { controllerNeedsApproval: boolean; agentsNeedApproval: boolean };
  // questions about a task (server/ask.ts): the Claude Code account and model of the separate agent
  ask: { account: string; model: string };
}

const FILE = join(TB_DIR, 'machine.json');

// macOS local host name ("Marios-MacBook-Pro"), else the host name without its domain
function defaultName() {
  try { const n = execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim(); if (n) return n; } catch { /* not macOS */ }
  return hostname().split('.')[0];
}

export const DEFAULT_ROUTING_RULES = `Use Claude Code or Codex for deep planning and hard coding work.
Use Antigravity for routine work. Do not use it for deep planning.
When Claude's 5-hour or weekly usage exceeds 70%, use Codex for deep planning.
Avoid accounts at their limit or running their maximum number of tasks.`;
let settings: MachineSettings = { name: process.env.TASKBOARD_MACHINE_NAME || defaultName(), routingRules: DEFAULT_ROUTING_RULES, controller: { autostart: true, remoteControl: true }, permissions: { controllerNeedsApproval: false, agentsNeedApproval: true }, ask: { account: 'claude-default', model: 'sonnet' } };
if (existsSync(FILE)) {
  const saved = JSON.parse(readFileSync(FILE, 'utf8'));
  settings = { ...settings, ...saved, controller: { ...settings.controller, ...saved.controller }, permissions: { ...settings.permissions, ...saved.permissions }, ask: { ...settings.ask, ...saved.ask } };
} else writeFileSync(FILE, JSON.stringify(settings, null, 2));

export const get = () => settings;
export const controllerLabel = () => `Taskboard controller · ${settings.name}`;
export function update(patch: { name?: string; routingRules?: string; autostart?: boolean; remoteControl?: boolean; controllerNeedsApproval?: boolean; agentsNeedApproval?: boolean; askAccount?: string; askModel?: string }) {
  if (patch.routingRules !== undefined) {
    if (typeof patch.routingRules !== 'string') throw new Error('routingRules must be text.');
    settings.routingRules = patch.routingRules.trim().slice(0, 1000);
  }
  if (patch.controllerNeedsApproval !== undefined) settings.permissions.controllerNeedsApproval = !!patch.controllerNeedsApproval;
  if (patch.agentsNeedApproval !== undefined) settings.permissions.agentsNeedApproval = !!patch.agentsNeedApproval;
  if (patch.name !== undefined && patch.name.trim()) settings.name = patch.name.trim().slice(0, 40);
  if (patch.autostart !== undefined) settings.controller.autostart = !!patch.autostart;
  if (patch.remoteControl !== undefined) settings.controller.remoteControl = !!patch.remoteControl;
  if (patch.askAccount) settings.ask.account = patch.askAccount;
  if (patch.askModel && ['sonnet', 'haiku', 'opus'].includes(patch.askModel)) settings.ask.model = patch.askModel;
  writeFileSync(FILE, JSON.stringify(settings, null, 2));
  return settings;
}
