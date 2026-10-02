// Shared by scripts/sandbox.mjs, release.mjs and rollback.mjs.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const TB_DIR = join(homedir(), '.taskboard');          // the real Taskboard (production)
export const RELEASES = join(TB_DIR, 'releases');
export const APP = join(TB_DIR, 'app');                       // symlink to the current release
export const PROD_URL = 'http://127.0.0.1:4317';
export const LAUNCHD_LABEL = 'com.taskboard.server';
export const SANDBOXES = join(tmpdir(), 'taskboard-sandbox');

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const log = (...a) => console.log(...a);

export function freePort(from) {
  return new Promise(resolve => {
    const tryPort = p => { const s = createServer(); s.once('error', () => tryPort(p + 1)); s.listen(p, '127.0.0.1', () => s.close(() => resolve(p))); };
    tryPort(from);
  });
}

// tokenFile is read on every attempt: a server creates its token when it first starts
export async function waitForInfo(url, tokenFile, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let token = ''; try { token = readFileSync(tokenFile, 'utf8').trim(); } catch { /* not created yet */ }
    try { const r = await fetch(url + '/api/info', { headers: { 'x-taskboard-token': token }, signal: AbortSignal.timeout(2000) }); if (r.ok) return r.json(); } catch { /* not up yet */ }
    await sleep(500);
  }
  return null;
}

// Start a Taskboard server from `root` in the background. env: extra variables (a sandbox sets TASKBOARD_DIR etc.).
export function startServer(root, env, logFile) {
  const out = openSync(logFile, 'a');
  const p = spawn(join(root, 'node_modules', '.bin', 'tsx'), ['server/index.ts'], { cwd: root, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', out, out] });
  p.unref();
  return p.pid;
}

export const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
export const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };

export function launchdLoaded() {
  try { execFileSync('launchctl', ['print', `gui/${process.getuid()}/${LAUNCHD_LABEL}`], { stdio: 'ignore' }); return true; } catch { return false; }
}

// Tell the running server why the SIGTERM that follows comes (server/server-life.ts reads the file): its start
// history then records a release, a rollback or a restart from the dashboard or tb restart, not an unknown signal.
export function announceStop(tbDir, reason, detail) {
  try { writeJson(join(tbDir, 'restart-intent.json'), { reason, at: new Date().toISOString(), detail }); } catch { /* no folder */ }
}

// Restart the real Taskboard on whatever APP points to. With launchd: kickstart. Without: stop the recorded
// process and start the new one in the background. Returns the /api/info of the new server, or null.
// reason: 'release' or 'rollback', for the start history.
export async function restartProduction(reason = 'release', detail) {
  announceStop(TB_DIR, reason, detail);
  const before = readJson(join(TB_DIR, 'server.pid'), null);
  if (launchdLoaded()) {
    execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${LAUNCHD_LABEL}`]);
  } else {
    // signal the recorded pid only if the running server confirms it (a stale pid may belong to another program)
    const running = await waitForInfo(PROD_URL, join(TB_DIR, 'token'), 2000);
    if (running?.pid) { process.kill(running.pid, 'SIGTERM'); for (let i = 0; i < 40 && alive(running.pid); i++) await sleep(250); }
    startServer(APP, {}, join(TB_DIR, 'server.log'));
  }
  // wait for a server that is not the old process
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const info = await waitForInfo(PROD_URL, join(TB_DIR, 'token'), 3000);
    if (info && info.pid !== before?.pid) return info;
    await sleep(500);
  }
  return null;
}

// After a switch: the new server must keep the same process for `ms` (a release that starts and then crashes makes
// launchd restart it, which shows up as a new pid or no answer). Returns true if it stayed up.
export async function staysUp(pid, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(5000);
    const info = await waitForInfo(PROD_URL, join(TB_DIR, 'token'), 4000);
    if (!info || info.pid !== pid) return false;
  }
  return true;
}

// Point APP at a release directory (atomic: a new symlink is renamed over the old one).
export function switchTo(dir) {
  const tmp = APP + '.new';
  rmSync(tmp, { force: true });
  symlinkSync(dir, tmp);
  renameSync(tmp, APP);
}

export function releases() {
  if (!existsSync(RELEASES)) return [];
  return readdirSync(RELEASES).map(id => ({ id, dir: join(RELEASES, id), meta: readJson(join(RELEASES, id, 'RELEASE.json'), null) }))
    .filter(r => r.meta).sort((a, b) => a.meta.created.localeCompare(b.meta.created));
}
export function currentRelease() { try { return readdirSync(RELEASES).find(id => join(RELEASES, id) === execFileSync('readlink', [APP], { encoding: 'utf8' }).trim()); } catch { return undefined; } }

export function ensureDir(d) { mkdirSync(d, { recursive: true }); return d; }
export function writeJson(f, v) { writeFileSync(f, JSON.stringify(v, null, 2)); }
