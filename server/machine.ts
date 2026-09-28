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
  permissions: { controllerNeedsApproval: boolean; agentsNeedApproval: boolean };
}

const FILE = join(TB_DIR, 'machine.json');

// macOS local host name ("Marios-MacBook-Pro"), else the host name without its domain
function defaultName() {
  try { const n = execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim(); if (n) return n; } catch { /* not macOS */ }
  return hostname().split('.')[0];
}

let settings: MachineSettings = { name: process.env.TASKBOARD_MACHINE_NAME || defaultName(), controller: { autostart: true, remoteControl: true }, permissions: { controllerNeedsApproval: false, agentsNeedApproval: true } };
if (existsSync(FILE)) {
  const saved = JSON.parse(readFileSync(FILE, 'utf8'));
  settings = { ...settings, ...saved, controller: { ...settings.controller, ...saved.controller }, permissions: { ...settings.permissions, ...saved.permissions } };
} else writeFileSync(FILE, JSON.stringify(settings, null, 2));

export const get = () => settings;
export const controllerLabel = () => `Taskboard controller · ${settings.name}`;
export function update(patch: { name?: string; autostart?: boolean; remoteControl?: boolean; controllerNeedsApproval?: boolean; agentsNeedApproval?: boolean }) {
  if (patch.controllerNeedsApproval !== undefined) settings.permissions.controllerNeedsApproval = !!patch.controllerNeedsApproval;
  if (patch.agentsNeedApproval !== undefined) settings.permissions.agentsNeedApproval = !!patch.agentsNeedApproval;
  if (patch.name !== undefined && patch.name.trim()) settings.name = patch.name.trim().slice(0, 40);
  if (patch.autostart !== undefined) settings.controller.autostart = !!patch.autostart;
  if (patch.remoteControl !== undefined) settings.controller.remoteControl = !!patch.remoteControl;
  writeFileSync(FILE, JSON.stringify(settings, null, 2));
  return settings;
}
