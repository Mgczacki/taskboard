// Sets up the A2A Notes service from the dashboard. A2A Notes is installed with Taskboard as the `a2a-notes`
// dependency, but it runs as its own process with its own data folder, and other clients use it the same way.
// Setup does each missing step and skips the steps that are already done, so a service that the user installed
// before (for example with `npm link`) is used as it is:
// 1. write the A2A Notes config.json with the Taskboard Slack app
// 2. start the service: a LaunchAgent on macOS for the real Taskboard, a background process for a test server
// 3. make one client token for each role and write a2anotes.json (server/a2anotes/client.ts)
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { HOME, TB_DIR } from '../config.ts';
import { SLACK_CLIENT_ID, SLACK_TEAM_ID } from '../mail/slack.ts';
import { savePrivate } from '../mail/store.ts';
import type { Role, Settings } from './client.ts';

const run = promisify(execFile);
const realTaskboard = TB_DIR === join(HOME, '.taskboard');
// the Taskboard Slack app lists http://localhost:4460/slack/callback as a redirect; a test server uses its own port
export const SERVICE_PORT = Number(process.env.TASKBOARD_A2A_PORT || (realTaskboard ? 4460 : 4461));
// the real Taskboard uses the A2A Notes default folder, so a service that the user started by hand is found
export const SERVICE_DIR = process.env.A2A_NOTES_DIR || (realTaskboard ? join(homedir(), '.a2a-notes') : join(TB_DIR, 'a2a-notes'));
const AGENT_FILE = join(homedir(), 'Library', 'LaunchAgents', 'com.a2anotes.service.plist');
const useLaunchAgent = () => process.platform === 'darwin' && realTaskboard && process.env.TASKBOARD_A2A_LAUNCH !== 'process';

// The package exports only its code, not package.json: resolve the main file (dist/index.js) and go up to the folder.
function packageDir() {
  try {
    let dir = dirname(createRequire(import.meta.url).resolve('a2a-notes'));
    while (!existsSync(join(dir, 'package.json')) && dirname(dir) !== dir) dir = dirname(dir);
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === 'a2a-notes' ? dir : undefined;
  } catch { return undefined; }
}
export function packageVersion() {
  const dir = packageDir();
  return dir ? String(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version) : undefined;
}
// The release folder changes with each Taskboard release, and old releases are removed. TB_DIR/app always points
// to the running release, so the LaunchAgent uses the command through that path.
function command() {
  const stable = join(TB_DIR, 'app', 'node_modules', 'a2a-notes', 'bin', 'a2a-notes.js');
  if (existsSync(stable)) return stable;
  const dir = packageDir();
  if (!dir) throw new Error('A2A Notes is not installed with this Taskboard. Run pnpm install in the Taskboard folder.');
  return join(dir, 'bin', 'a2a-notes.js');
}
const cli = async (...args: string[]) => (await run(process.execPath, [command(), ...args, '--dir', SERVICE_DIR], { timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout.trim();

function servicePort() {
  try { return Number(JSON.parse(readFileSync(join(SERVICE_DIR, 'config.json'), 'utf8')).port) || SERVICE_PORT; } catch { return SERVICE_PORT; }
}
async function health(port = servicePort()): Promise<{ version?: string } | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : undefined;
  } catch { return undefined; }
}
async function waitFor(check: () => Promise<boolean>, ms: number) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 300))) if (await check()) return true;
  return false;
}

export interface SetupState {
  installed: boolean; version?: string; configured: boolean; running: boolean; serviceVersion?: string;
  linked: boolean; launchAgent: boolean; folder: string; port: number;
  // the running service is older than the package that Taskboard installed
  updateAvailable: boolean;
}
export async function setupState(settings: Settings): Promise<SetupState> {
  const version = packageVersion(), h = await health();
  return {
    installed: !!version, version, configured: existsSync(join(SERVICE_DIR, 'config.json')), running: !!h, serviceVersion: h?.version,
    linked: settings.enabled && (['person', 'reviewer', 'agent'] as Role[]).every(r => !!settings.tokens[r]),
    launchAgent: existsSync(AGENT_FILE), folder: SERVICE_DIR, port: servicePort(),
    updateAvailable: !!(h && version && h.version && h.version !== version),
  };
}

let running: Promise<SetupState> | undefined;
export function setup(settingsFile: string, read: () => Settings) {
  // one setup at a time: a second click waits for the first one
  running ||= doSetup(settingsFile, read).finally(() => { running = undefined; });
  return running;
}

async function doSetup(settingsFile: string, read: () => Settings): Promise<SetupState> {
  let state = await setupState(read());
  if (!state.installed) throw new Error('A2A Notes is not installed with this Taskboard. Run pnpm install in the Taskboard folder.');
  if (!state.configured) {
    mkdirSync(SERVICE_DIR, { recursive: true, mode: 0o700 });
    await cli('init', '--client-id', SLACK_CLIENT_ID, '--team-id', SLACK_TEAM_ID, '--port', String(SERVICE_PORT));
  }
  if (state.running && state.updateAvailable && state.launchAgent) {
    // the LaunchAgent starts the service again (KeepAlive) with the package of the running Taskboard release
    await cli('stop').catch(() => {});
    await waitFor(async () => (await health())?.version === state.version, 20_000);
  } else if (!state.running) {
    if (useLaunchAgent()) {
      if (!existsSync(AGENT_FILE)) {
        mkdirSync(dirname(AGENT_FILE), { recursive: true });
        writeFileSync(AGENT_FILE, await cli('service-file'));
      }
      await run('launchctl', ['load', '-w', AGENT_FILE], { timeout: 15_000 }).catch(() => {});
    } else {
      // a test server: a background process that ends with the machine session, not a LaunchAgent
      const child = spawn(process.execPath, [command(), 'serve', '--dir', SERVICE_DIR], { detached: true, stdio: 'ignore' });
      child.unref();
    }
    if (!await waitFor(async () => !!await health(), 20_000)) throw new Error(`A2A Notes did not start on port ${servicePort()}. Check ${join(SERVICE_DIR, 'service.log')}.`);
  }
  state = await setupState(read());
  if (!state.linked) {
    const tokens: Partial<Record<Role, string>> = {};
    for (const role of ['person', 'reviewer', 'agent'] as Role[]) tokens[role] = await cli('token', 'add', `taskboard-${role}`, '--role', role);
    if (Object.values(tokens).some(t => !/^a2an_[A-Za-z0-9_-]{20,100}$/.test(t || ''))) throw new Error('A2A Notes did not return client tokens.');
    savePrivate(settingsFile, { enabled: true, url: `http://127.0.0.1:${servicePort()}/mcp`, tokens });
  }
  return setupState(read());
}
