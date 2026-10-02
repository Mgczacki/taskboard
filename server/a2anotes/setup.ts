// Sets up the A2A Notes service from the dashboard. A2A Notes is installed with Taskboard as the `a2a-notes`
// dependency, but it runs as its own process with its own data folder, and other clients use it the same way.
// Setup does each missing step and skips the steps that are already done, so a service that the user installed
// before (for example with `npm link`) is used as it is:
// 1. write the A2A Notes config.json with the Slack app from server/a2anotes/slack-app.ts (the A2A Notes app by default)
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
import { DEFAULT_SLACK_CLIENT_ID, DEFAULT_SLACK_TEAM_ID, appName, redirectUrl, signInHelp, slackApp } from './slack-app.ts';

const run = promisify(execFile);
// the default Slack app: the separate A2A Notes app (8696283833057.12198817279122) in the Sekai workspace. It lists
// http://localhost:4460/slack/callback as a redirect URL. The Taskboard settings and TASKBOARD_A2A_SLACK_CLIENT_ID and
// TASKBOARD_A2A_SLACK_TEAM_ID can choose another app (slackApp in server/a2anotes/slack-app.ts).
export const SLACK_CLIENT_ID = DEFAULT_SLACK_CLIENT_ID;
export const SLACK_TEAM_ID = DEFAULT_SLACK_TEAM_ID;
const realTaskboard = TB_DIR === join(HOME, '.taskboard');
// The Slack app must list http://localhost:<port>/slack/callback for this port. integrations/slack/a2a-notes-manifest.json
// lists 4460 for the real Taskboard and 4461 for a test server. Another TASKBOARD_A2A_PORT needs its own redirect URL.
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
// The writing rules for message bodies that the a2a-notes package ships (0.4.0 and later). The controller instructions
// point to it through TB_DIR/app, which stays the same across releases; a test server without TB_DIR/app uses its own package.
export function writingGuide() {
  const stable = join(TB_DIR, 'app', 'node_modules', 'a2a-notes', 'docs', 'WRITING-MESSAGES.md');
  const dir = existsSync(join(TB_DIR, 'app')) ? undefined : packageDir();
  return dir ? join(dir, 'docs', 'WRITING-MESSAGES.md') : stable;
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
// the Slack app in the A2A Notes config.json, which is the app that the running service signs in with
function slackInConfig(): { clientId: string; teamId: string; redirectUri: string } | undefined {
  try {
    const c = JSON.parse(readFileSync(configFile(), 'utf8')).slack;
    return c && typeof c.clientId === 'string' ? { clientId: c.clientId, teamId: String(c.teamId || ''), redirectUri: String(c.redirectUri || '') } : undefined;
  } catch { return undefined; }
}
const sameChecks = (a: ReturnType<typeof checkCommands>, b: ReturnType<typeof checkCommands>) => JSON.stringify(a.reviewCommand || null) === JSON.stringify(b.reviewCommand || null) && JSON.stringify(a.bodyCheckCommand || null) === JSON.stringify(b.bodyCheckCommand || null);

export interface SetupState {
  installed: boolean; version?: string; configured: boolean; running: boolean; serviceVersion?: string;
  linked: boolean; launchAgent: boolean; folder: string; port: number;
  // the running service is older than the package that Taskboard installed
  updateAvailable: boolean;
  // how to restart the service on this install, for the warning on the dashboard
  restartStep: string;
  // model: the config has the Claude check commands; rules: the fixed rules only
  checks: 'model' | 'rules';
  // the config has other check commands than this Taskboard would write (for example a new controller account)
  checksOutdated: boolean;
  // the Slack app in the A2A Notes config.json (the app that sign-in uses), when the config exists
  slack?: { clientId: string; teamId: string; redirectUri: string; name?: string };
  // the Slack app that this Taskboard chooses (settings, environment, or default) and the redirect URL it must list
  slackApp: { clientId: string; teamId: string; source: 'settings' | 'environment' | 'default'; name?: string; redirectUri: string };
  // the config has another Slack app than this Taskboard chooses; "Use this Slack app" writes the chosen one
  slackAppDiffers: boolean;
  // the plain help for a failed Slack sign-in, for the app that sign-in uses
  signInHelp: string[];
}
// true when version a is older than version b (both in the form 1.2.3; a part that is not a number counts as 0)
export function olderVersion(a: string, b: string) {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0), pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
}
// The "Restart A2A Notes" button runs setup, which runs `a2a-notes stop`. The LaunchAgent (KeepAlive) then starts the
// service again with the package under TB_DIR/app. A test server starts it again as a background process.
function restartStep(launchAgent: boolean) {
  return launchAgent && useLaunchAgent()
    ? `Click Restart A2A Notes. Taskboard stops the service, and the LaunchAgent com.a2anotes.service starts it again with the installed package. In a terminal, the same step is: launchctl kickstart -k gui/${process.getuid?.() ?? '$(id -u)'}/com.a2anotes.service`
    : 'Click Restart A2A Notes. Taskboard stops the service and starts it again as a background process with the installed package.';
}
export async function setupState(settings: Settings): Promise<SetupState> {
  const version = packageVersion(), h = await health();
  const inConfig = slackInConfig(), chosen = { ...slackApp(), redirectUri: redirectUrl(SERVICE_PORT) };
  const used = inConfig || chosen;
  return {
    installed: !!version, version, configured: existsSync(join(SERVICE_DIR, 'config.json')), running: !!h, serviceVersion: h?.version,
    linked: settings.enabled && (['person', 'reviewer', 'agent'] as Role[]).every(r => !!settings.tokens[r]),
    launchAgent: existsSync(AGENT_FILE), folder: SERVICE_DIR, port: servicePort(),
    updateAvailable: !!(h && version && h.version && olderVersion(h.version, version)),
    restartStep: restartStep(existsSync(AGENT_FILE)),
    checks: checksInConfig().reviewCommand ? 'model' : 'rules',
    checksOutdated: existsSync(configFile()) && !sameChecks(checksInConfig(), checkCommands()),
    ...(inConfig ? { slack: { ...inConfig, name: appName(inConfig.clientId) } } : {}),
    slackApp: chosen,
    slackAppDiffers: !!inConfig && (inConfig.clientId !== chosen.clientId || inConfig.teamId !== chosen.teamId),
    signInHelp: signInHelp(used.clientId, used.redirectUri || chosen.redirectUri),
  };
}

let running: Promise<SetupState> | undefined;
// applySlackApp: write the Slack app that this Taskboard chooses into an existing A2A Notes config.json. Only the
// "Use this Slack app" button sends it, so setup never changes the app of a config that the user wrote by hand.
export function setup(settingsFile: string, read: () => Settings, options: { applySlackApp?: boolean } = {}) {
  // one setup at a time: a second click waits for the first one
  running ||= doSetup(settingsFile, read, options).finally(() => { running = undefined; });
  return running;
}

async function doSetup(settingsFile: string, read: () => Settings, options: { applySlackApp?: boolean }): Promise<SetupState> {
  let state = await setupState(read());
  if (!state.installed) throw new Error('A2A Notes is not installed with this Taskboard. Run pnpm install in the Taskboard folder.');
  if (!state.configured) {
    mkdirSync(SERVICE_DIR, { recursive: true, mode: 0o700 });
    const app = slackApp();
    await cli('init', '--client-id', app.clientId, '--team-id', app.teamId, '--port', String(SERVICE_PORT));
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
  // the Slack app is read when the service starts too. The redirect URL keeps the port of the config.
  if (options.applySlackApp && state.slackAppDiffers) {
    const config = JSON.parse(readFileSync(configFile(), 'utf8')), app = slackApp();
    savePrivate(configFile(), { ...config, slack: { ...config.slack, clientId: app.clientId, teamId: app.teamId, redirectUri: config.slack?.redirectUri || redirectUrl(SERVICE_PORT) } });
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
