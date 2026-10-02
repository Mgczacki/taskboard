// The login service that starts this server, for the one-line status in Settings → Server starts (GET /api/server).
// - label: launchd sets XPC_SERVICE_NAME to the label of the job it started; a server started by hand has none (or
//   "0"), and then the label is the real one, com.taskboard.server, for production and none for a sandbox.
// - startsAtLogin: the plist is in ~/Library/LaunchAgents and the label is not disabled (launchctl print-disabled).
// - loaded: launchctl print finds the label.
// - runsThisServer: the job's pid is this process.
// Only reading commands run here. Other systems have no login service check yet: the answer is null.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { HOME } from './config.ts';
import { ROLE } from './instance.ts';

const exec = promisify(execFile);
export interface LoginService { label: string; startsAtLogin: boolean; loaded: boolean; runsThisServer: boolean }

export const serviceLabel = (env = process.env, role = ROLE): string | null =>
  env.XPC_SERVICE_NAME && env.XPC_SERVICE_NAME !== '0' ? env.XPC_SERVICE_NAME : role === 'production' ? 'com.taskboard.server' : null;

// `launchctl print gui/<uid>/<label>` → loaded and pid; `launchctl print-disabled gui/<uid>` → "label" => disabled
export function parseLoginService(label: string, plistExists: boolean, print: string | null, disabled: string, pid: number): LoginService {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const off = new RegExp(`"${esc}" => (disabled|true)`).test(disabled);
  const jobPid = print ? Number((print.match(/^\s*pid = (\d+)/m) || [])[1]) || 0 : 0;
  return { label, startsAtLogin: plistExists && !off, loaded: print !== null, runsThisServer: jobPid === pid };
}

export async function loginService(): Promise<LoginService | null> {
  const label = serviceLabel();
  if (process.platform !== 'darwin' || !label) return null;
  const domain = `gui/${process.getuid?.() ?? 0}`;
  const run = async (args: string[]) => { try { return (await exec('launchctl', args, { timeout: 3000, encoding: 'utf8' })).stdout; } catch { return null; } };
  const [print, disabled] = await Promise.all([run(['print', `${domain}/${label}`]), run(['print-disabled', domain])]);
  return parseLoginService(label, existsSync(join(HOME, 'Library', 'LaunchAgents', `${label}.plist`)), print, disabled || '', process.pid);
}
