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
  controller: { autostart: boolean; remoteControl: boolean };
  // actions through `tb` that act on other tasks (new, send, set aside, archive): run at once, or wait for Approve
  permissions: { controllerNeedsApproval: boolean; agentsNeedApproval: boolean; trustWorkspaces: boolean; autoReview: boolean };
  // questions about a task (server/ask.ts): the separate agent, account, and model
  ask: { agent: 'claude' | 'codex'; account: string; model: string };
  review: { account: string; model: string };
}

const FILE = join(TB_DIR, 'machine.json');

// macOS local host name ("Marios-MacBook-Pro"), else the host name without its domain
function defaultName() {
  try { const n = execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim(); if (n) return n; } catch { /* not macOS */ }
  return hostname().split('.')[0];
}

let settings: MachineSettings = { name: process.env.TASKBOARD_MACHINE_NAME || defaultName(), controller: { autostart: true, remoteControl: true }, permissions: { controllerNeedsApproval: false, agentsNeedApproval: true, trustWorkspaces: true, autoReview: true }, ask: { agent: 'claude', account: 'claude-default', model: 'sonnet' }, review: { account: 'claude-default', model: 'sonnet' } };
if (existsSync(FILE)) {
  const saved = JSON.parse(readFileSync(FILE, 'utf8'));
  settings = { ...settings, ...saved, controller: { ...settings.controller, ...saved.controller }, permissions: { ...settings.permissions, ...saved.permissions }, ask: { ...settings.ask, ...saved.ask }, review: { ...settings.review, ...saved.review } };
} else writeFileSync(FILE, JSON.stringify(settings, null, 2));

export const get = () => settings;
export const controllerLabel = () => `Taskboard controller · ${settings.name}`;
export function update(patch: { name?: string; autostart?: boolean; remoteControl?: boolean; controllerNeedsApproval?: boolean; agentsNeedApproval?: boolean; trustWorkspaces?: boolean; autoReview?: boolean; askAgent?: 'claude' | 'codex'; askAccount?: string; askModel?: string; reviewAccount?: string; reviewModel?: string }) {
  if (patch.controllerNeedsApproval !== undefined) settings.permissions.controllerNeedsApproval = !!patch.controllerNeedsApproval;
  if (patch.agentsNeedApproval !== undefined) settings.permissions.agentsNeedApproval = !!patch.agentsNeedApproval;
  if (patch.trustWorkspaces !== undefined) settings.permissions.trustWorkspaces = !!patch.trustWorkspaces;
  if (patch.autoReview !== undefined) settings.permissions.autoReview = !!patch.autoReview;
  if (patch.name !== undefined && patch.name.trim()) settings.name = patch.name.trim().slice(0, 40);
  if (patch.autostart !== undefined) settings.controller.autostart = !!patch.autostart;
  if (patch.remoteControl !== undefined) settings.controller.remoteControl = !!patch.remoteControl;
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
