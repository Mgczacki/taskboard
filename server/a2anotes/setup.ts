// Sets up the A2A Notes service from the dashboard. A2A Notes is installed with Taskboard as the `a2a-notes`
// dependency, but it runs as its own process with its own data folder, and other clients use it the same way.
// Setup does each missing step and skips the steps that are already done, so a service that the user installed
// before (for example with `npm link`) is used as it is:
// 1. write the A2A Notes config.json with the Taskboard Slack app
// 2. start the service: a LaunchAgent on macOS for the real Taskboard, a background process for a test server
// 3. make one client token for each role and write a2anotes.json (server/a2anotes/client.ts)
// It also writes the model check commands (server/a2anotes/check-command.mjs) into the A2A Notes config. They use the
// controller's Claude account, and setup restarts the service when they change.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { HOME, ROOT, TB_DIR } from '../config.ts';
import * as accounts from '../accounts.ts';
import * as tasks from '../store.ts';
import { savePrivate } from './files.ts';
import type { Role, Settings } from './client.ts';

const run = promisify(execFile);
// the Taskboard Slack app; it lists http://localhost:4460/slack/callback as a redirect URL
export const SLACK_CLIENT_ID = '8696283833057.12177743257233';
export const SLACK_TEAM_ID = 'T08LG8BQH1P';
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

// The check commands for the A2A Notes config: Claude with the controller's account, through check-command.mjs.
// Without the claude program or a Claude controller account, A2A Notes uses its fixed rules only.
function checkCommands(): { reviewCommand?: string[]; bodyCheckCommand?: string[] } {
  // tests and test servers set TASKBOARD_A2A_CHECKS=rules, so they never run a model with the real Claude account
  if (process.env.TASKBOARD_A2A_CHECKS === 'rules') return {};
  const account = accounts.get(tasks.get('controller')?.account || '') || accounts.defaultFor('claude');
  let claude = '';
  try { claude = execFileSync('/usr/bin/which', ['claude'], { encoding: 'utf8', timeout: 5000 }).trim(); } catch { return {}; }
  if (!claude || account?.agent !== 'claude') return {};
  const stable = join(TB_DIR, 'app', 'server', 'a2anotes', 'check-command.mjs');
  const script = existsSync(stable) ? stable : join(ROOT, 'server', 'a2anotes', 'check-command.mjs');
  const base = [process.execPath, script];
  const tail = ['--claude', claude, ...(account.dir ? ['--config', account.dir] : [])];
  return { reviewCommand: [...base, 'review', ...tail], bodyCheckCommand: [...base, 'body', ...tail] };
}
function configFile() { return join(SERVICE_DIR, 'config.json'); }
function checksInConfig() {
  try { const c = JSON.parse(readFileSync(configFile(), 'utf8')); return { reviewCommand: c.reviewCommand, bodyCheckCommand: c.bodyCheckCommand }; } catch { return {}; }
}
const sameChecks = (a: ReturnType<typeof checkCommands>, b: ReturnType<typeof checkCommands>) => JSON.stringify(a.reviewCommand || null) === JSON.stringify(b.reviewCommand || null) && JSON.stringify(a.bodyCheckCommand || null) === JSON.stringify(b.bodyCheckCommand || null);

export interface SetupState {
  installed: boolean; version?: string; configured: boolean; running: boolean; serviceVersion?: string;
  linked: boolean; launchAgent: boolean; folder: string; port: number;
  // the running service is older than the package that Taskboard installed
  updateAvailable: boolean;
  // model: the config has the Claude check commands; rules: the fixed rules only
  checks: 'model' | 'rules';
  // the config has other check commands than this Taskboard would write (for example a new controller account)
  checksOutdated: boolean;
}
export async function setupState(settings: Settings): Promise<SetupState> {
  const version = packageVersion(), h = await health();
  return {
    installed: !!version, version, configured: existsSync(join(SERVICE_DIR, 'config.json')), running: !!h, serviceVersion: h?.version,
    linked: settings.enabled && (['person', 'reviewer', 'agent'] as Role[]).every(r => !!settings.tokens[r]),
    launchAgent: existsSync(AGENT_FILE), folder: SERVICE_DIR, port: servicePort(),
    updateAvailable: !!(h && version && h.version && h.version !== version),
    checks: checksInConfig().reviewCommand ? 'model' : 'rules',
    checksOutdated: existsSync(configFile()) && !sameChecks(checksInConfig(), checkCommands()),
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
  // the check commands are read when the service starts: write them, then restart a running service
  const wanted = checkCommands();
  let restart = false;
  if (!sameChecks(checksInConfig(), wanted)) {
    const config = JSON.parse(readFileSync(configFile(), 'utf8'));
    delete config.reviewCommand; delete config.bodyCheckCommand;
    savePrivate(configFile(), { ...config, ...wanted });
    restart = state.running;
  }
  if (state.running && (restart || state.updateAvailable)) {
    // a LaunchAgent starts the service again at once (KeepAlive), with the package of the running Taskboard release;
    // a background process for a test server stays stopped, and the start below runs it again
    await cli('stop').catch(() => {});
    if (state.launchAgent && useLaunchAgent()) await waitFor(async () => (await health())?.version === state.version, 20_000);
    else await waitFor(async () => !await health(), 10_000);
    state = await setupState(read());
  }
  if (!state.running) {
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
