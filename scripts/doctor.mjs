// pnpm doctor: why the Taskboard server does not answer, and the step that repairs it (desktop/doctor.cjs).
//   pnpm doctor            prints the state, the reason and the last log lines; changes nothing. Tasks may run it.
//   pnpm doctor --repair   runs the repair that the state offers (install the login service, or restart it).
//                          Only the user runs it: it refuses inside a Taskboard task for the real service.
//   pnpm doctor --json     the facts and the state as JSON.
// It also checks the working directory of the tmux server of the agents (TASKBOARD_TMUX_SOCKET, default taskboard):
// when that folder was deleted, new task sessions fail (scripts/cwd-check.mjs). It never restarts tmux.
// It compares the global options of that tmux server with the Taskboard settings (scripts/tmux-settings.mjs: status
// bar off, mouse on, remain-on-exit on, the bell hook) and sets them again when they differ. They are global options,
// so no session changes. This is the only change that pnpm doctor makes without its repair option.
// The Taskboard app shows the same check on its waiting page, with a Start server button.
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { STABLE_DIR, tmuxFolderProblem, tmuxServerFolder } from './cwd-check.mjs';
import { applySettings, bindingsFileIn, compareSettings, SETTINGS_VERSION } from './tmux-settings.mjs';

const doctor = createRequire(import.meta.url)('../desktop/doctor.cjs');
const args = process.argv.slice(2);
const cfg = doctor.config();

if (args.includes('--repair')) {
  if (process.env.TASK_ID && cfg.label === doctor.REAL_LABEL) {
    console.log('Not repaired: this runs inside a Taskboard task. Only the user repairs the real login service, from the Taskboard app (Start server) or Terminal.');
    process.exit(1);
  }
  const r = await doctor.repair(cfg);
  for (const l of r.output || []) if (l !== r.line) console.log(`  ${l}`);
  console.log(r.line);
  if (r.after) console.log(`Now: ${r.after.title}.`);
  process.exit(r.ok ? 0 : 1);
}

const c = await doctor.check(cfg);
const socket = process.env.TASKBOARD_TMUX_SOCKET || 'taskboard', tmuxBin = process.env.TASKBOARD_TMUX || 'tmux';
const tmux = await tmuxServerFolder(socket, tmuxBin).catch(() => null);
const tmuxProblem = tmuxFolderProblem(tmux, socket, tmuxBin);
// The settings check needs the token of this Taskboard (the bell hook sends it). The token is never printed.
const tokenFile = join(cfg.tbDir, 'token'), urlBase = `http://127.0.0.1:${cfg.port}`;
const runTmux = async args => (await promisify(execFile)(tmuxBin, ['-L', socket, ...args], { cwd: STABLE_DIR })).stdout;
let tmuxSettings = null;
if (tmux && existsSync(tokenFile)) {
  const token = readFileSync(tokenFile, 'utf8').trim();
  const differ = await compareSettings(runTmux, token, urlBase).catch(() => null);
  if (differ?.length) await applySettings(runTmux, token, urlBase, bindingsFileIn(cfg.tbDir));
  const after = differ?.length ? await compareSettings(runTmux, token, urlBase).catch(() => null) : differ;
  tmuxSettings = differ && { version: SETTINGS_VERSION, differed: differ, differ: after || [] };
}
const ok = c.ok && !tmuxProblem;
if (args.includes('--json')) { console.log(JSON.stringify({ ...c, tmux: tmux && { socket, ...tmux, problem: tmuxProblem, settings: tmuxSettings } }, null, 2)); process.exit(ok ? 0 : 1); }
const f = c.facts;
console.log(`${c.ok ? 'OK' : 'Problem'}: ${c.title}.`);
console.log(c.reason);
if (c.next) console.log(`Next step: ${c.next}`);
else if (c.action === 'install') console.log("Repair: click Start server in the Taskboard app, or run 'pnpm doctor --repair' (it runs scripts/install-launchd.sh of the release).");
else if (c.action === 'restart') console.log("Repair: click Start server in the Taskboard app, or run 'pnpm doctor --repair' (it restarts the login service).");
if (f.platform === 'darwin') {
  console.log('');
  console.log(`Login service ${f.label}: file ${f.plistExists ? 'present' : 'missing'}${f.disabled ? ', turned off' : ''}, ${f.loaded ? `loaded, state ${f.service?.state}${f.service?.pid ? `, process ${f.service.pid}` : ''}${f.service?.lastExit ? `, last exit code ${f.service.lastExit}` : ''}` : 'not loaded'}.`);
  console.log(`Program: ${f.program || 'unknown'}. Release: ${f.release || 'none'}.`);
  if (f.lastInstall) console.log(`Last install ${f.lastInstall.at}: ${f.lastInstall.line}`);
}
console.log('');
if (!tmux) console.log(`tmux server ${socket}: not running.`);
else if (tmuxProblem) console.log(`Problem: ${tmuxProblem}`);
else {
  console.log(`tmux server ${socket}: process ${tmux.pid}, working directory ${tmux.cwd ?? 'unknown'}.`);
  // a tmux server from before this change; the release prune keeps a folder that a process uses (scripts/lib.mjs)
  if (tmux.cwd?.includes('/.taskboard/releases/')) console.log('Note: this is a release folder. A release does not remove it while the tmux server runs. A restart of the tmux server moves it to the home folder.');
}
if (tmuxSettings) {
  if (!tmuxSettings.differed.length) console.log(`tmux settings: the Taskboard settings are set (version ${SETTINGS_VERSION}).`);
  else console.log(`tmux settings: these differed and were set again: ${tmuxSettings.differed.join(', ')}.${tmuxSettings.differ.length ? ` These still differ: ${tmuxSettings.differ.join(', ')}.` : ''}`);
}
if (c.logTail?.length) { console.log(`\nLast lines of ${f.log}:`); for (const l of c.logTail) console.log(`  ${l}`); }
process.exit(ok ? 0 : 1);
