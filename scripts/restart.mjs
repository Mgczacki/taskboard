#!/usr/bin/env node
// Restart the installed Taskboard server in one step. It does not build or release code: it starts the release that
// ~/.taskboard/app points to again (in a sandbox, the code of this checkout).
//
//   tb restart [--yes]                 the user, in a terminal (runs this file from the installed release)
//   node scripts/restart.mjs [--yes]   the same from a checkout
//   Settings → Taskboard server        the dashboard runs this file with --yes after you confirm there
//
// Steps:
// 1. Ask the running server what a restart does to its tasks (GET /api/restart/check) and print it.
// 2. If a restart stops work (an Ask answer, a permit command result, an account move, or agent sessions whose tmux
//    server would stop with Taskboard), list the tasks and ask for confirmation. --yes confirms.
// 3. Start the installed code once as a throwaway sandbox and check that it answers. If it does not, stop here: the
//    running server is not touched.
// 4. With the login service (launchd): launchctl kickstart -k. Without it: SIGTERM to the confirmed process, then start
//    the installed code in the background.
// 5. Wait until a server with a new process id answers, and print the result. If none answers, print the error and the
//    log path. Without launchd, try to start it one more time first.
// Agent sessions run in tmux (socket "taskboard"), which is its own process. They keep running and the new server
// finds them again.
//
// Taskboard tasks must not run this. The guard hook blocks it for agents (server/hooks/guard.mjs), and this file
// refuses to run when TASK_ID is set. The controller asks with `tb restart`, which puts a card on the dashboard.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { APP, LAUNCHD_LABEL, PROD_URL, TB_DIR, alive, ensureDir, freePort, launchdLoaded, readJson, sleep, startServer, waitForInfo, writeJson } from './lib.mjs';

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The text that tells the user what a restart does. impact is the answer of GET /api/restart/check, or null when the
// running server cannot answer that question (it is stopped, or it is an older release without the route).
export function describeImpact(impact, serverAnswers) {
  const lines = [];
  if (!serverAnswers) {
    lines.push('No Taskboard server answers now. The restart only starts it.');
    return { lines, mustConfirm: false };
  }
  if (!impact) {
    lines.push('The running server is an older release. It cannot list what a restart stops.');
    lines.push('Agent sessions run in tmux and normally keep running. Answers of Ask questions and permit results that are running now are lost.');
    return { lines, mustConfirm: true };
  }
  const n = impact.sessions.length;
  if (impact.tmuxStops) lines.push(`The tmux server of the agents (process ${impact.tmuxPid}) is in the same process group as Taskboard. A restart can stop all ${n} agent sessions.`);
  else lines.push(n ? `${n} agent session${n === 1 ? '' : 's'} keep${n === 1 ? 's' : ''} running in tmux. The new server finds ${n === 1 ? 'it' : 'them'} again.` : 'No agent session is running.');
  if (impact.stops.length) {
    lines.push('A restart stops this work:');
    for (const s of impact.stops) lines.push(`  - #${s.num} ${s.title}: ${s.what}`);
  }
  for (const note of impact.notes) lines.push(note);
  lines.push('Dashboard windows and terminal views disconnect for a few seconds and connect again by themselves.');
  return { lines, mustConfirm: impact.tmuxStops || impact.stops.length > 0 };
}

// Start `appDir` once on a free port with its own folders and tmux socket, and check that it answers.
export async function startCheck(appDir, log) {
  const t = join(tmpdir(), `taskboard-restart-check-${process.pid}`);
  ensureDir(join(t, 'tbdir'));
  writeJson(join(t, 'tbdir', 'machine.json'), { name: 'restart-check', controller: { autostart: false, remoteControl: false } });
  const port = await freePort(4470), socket = `tbrst-${process.pid}`;
  const env = { TASKBOARD_DIR: join(t, 'tbdir'), TASKBOARD_VAULT: join(t, 'vault'), TASKBOARD_PORT: String(port), TASKBOARD_TMUX_SOCKET: socket, TASKBOARD_MACHINE_NAME: 'restart-check' };
  const pid = startServer(appDir, env, join(t, 'server.log'));
  // wait up to 30 s, and stop waiting when the test server exits
  let info = null;
  for (const end = Date.now() + 30000; !info && alive(pid) && Date.now() < end;) info = await waitForInfo(`http://127.0.0.1:${port}`, join(t, 'tbdir', 'token'), 1500);
  if (alive(pid)) process.kill(pid, 'SIGTERM');
  try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* no sessions */ }
  if (!info) { log(`The installed code did not start in a test run. The running server was not changed. Log: ${join(t, 'server.log')}`); return false; }
  rmSync(t, { recursive: true, force: true });
  return true;
}

const tail = (file, n = 20) => { try { return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n).join('\n'); } catch { return '(no log)'; } };

// o: tbDir, appDir, url, env (for the new server), launchd, yes, confirm(lines) → Promise<boolean>, log,
//    kickstart(), check (run the start check), startMs (how long to wait for the new server)
// Returns { ok, code, message, oldPid?, newPid? }. The caller prints nothing else.
export async function restartTaskboard(o) {
  const log = o.log || console.log;
  const tokenFile = join(o.tbDir, 'token');
  const logFile = join(o.tbDir, 'server.log');
  const done = r => { try { writeJson(join(o.tbDir, 'restart-result.json'), { ...r, at: new Date().toISOString(), log: logFile }); } catch { /* folder is gone */ } return r; };

  if (!existsSync(join(o.appDir, 'server', 'index.ts')) || !existsSync(join(o.appDir, 'node_modules', '.bin', 'tsx')))
    return done({ ok: false, code: 1, message: `No installed Taskboard in ${o.appDir}. Nothing was stopped. Run pnpm release in the checkout to install one.` });

  // the running server, confirmed by its lock file (as scripts/stop.mjs does)
  const lock = readJson(join(o.tbDir, 'server.pid'), null);
  const before = await waitForInfo(o.url, tokenFile, 3000);
  if (before && lock && before.pid !== lock.pid)
    return done({ ok: false, code: 1, message: `The server at ${o.url} is process ${before.pid}, but ${join(o.tbDir, 'server.pid')} records ${lock.pid}. Nothing was stopped.` });

  // 1–2. what a restart does to running tasks
  let impact = null;
  if (before) {
    const token = readFileSync(tokenFile, 'utf8').trim();
    impact = await fetch(o.url + '/api/restart/check', { headers: { 'x-taskboard-token': token }, signal: AbortSignal.timeout(10000) })
      .then(r => r.ok ? r.json() : null).catch(() => null);
  }
  const { lines, mustConfirm } = describeImpact(impact, !!before);
  log('What a restart does:');
  for (const l of lines) log(`  ${l}`);
  if (mustConfirm && !o.yes) {
    if (!o.confirm || !(await o.confirm())) return { ok: false, code: 2, message: 'Not restarted. Nothing was stopped.' };
  }

  // 3. the installed code must start before the running server is stopped
  if (o.check !== false) {
    log('Checking that the installed code starts…');
    if (!(await startCheck(o.appDir, log))) return done({ ok: false, code: 1, message: 'Not restarted: the installed code did not pass its start check.' });
  }

  // 4. stop and start
  const oldPid = before?.pid;
  if (o.launchd) {
    log(`Restarting the login service ${LAUNCHD_LABEL}…`);
    try { o.kickstart(); } catch (e) { return done({ ok: false, code: 1, oldPid, message: `launchctl kickstart failed: ${e.message}. The server may still run as process ${oldPid}.` }); }
  } else {
    if (oldPid) {
      log(`Stopping process ${oldPid}…`);
      process.kill(oldPid, 'SIGTERM');
      for (let i = 0; i < 40 && alive(oldPid); i++) await sleep(250);
      if (alive(oldPid)) return done({ ok: false, code: 1, oldPid, message: `Process ${oldPid} did not stop within 10 s. No new server was started.` });
    }
    log(`Starting ${o.appDir}…`);
    startServer(o.appDir, o.env || {}, logFile);
  }

  // 5. a server with a new process id must answer
  const waitNew = async ms => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const info = await waitForInfo(o.url, tokenFile, 2000);
      if (info && info.pid !== oldPid) return info;
      await sleep(500);
    }
    return null;
  };
  let after = await waitNew(o.startMs || 30000);
  if (!after && !o.launchd && !(await waitForInfo(o.url, tokenFile, 1000))) {
    log('The new server did not answer. Starting it one more time…');
    startServer(o.appDir, o.env || {}, logFile);
    after = await waitNew(o.startMs || 30000);
  }
  if (!after) {
    const where = o.launchd ? 'launchd tries again every 10 s.' : 'No Taskboard server runs now.';
    return done({ ok: false, code: 1, oldPid, message: `The new server did not answer at ${o.url}. ${where} Log: ${logFile}\nLast lines of the log:\n${tail(logFile)}` });
  }
  let kept = '';
  try {
    const token = readFileSync(tokenFile, 'utf8').trim();
    const now = await fetch(o.url + '/api/restart/check', { headers: { 'x-taskboard-token': token }, signal: AbortSignal.timeout(10000) }).then(r => r.ok ? r.json() : null);
    if (now) kept = ` ${now.sessions.length} agent session${now.sessions.length === 1 ? '' : 's'} running in tmux.`;
  } catch { /* the count is only for the report */ }
  return done({ ok: true, code: 0, oldPid, newPid: after.pid, message: `Taskboard restarted: ${oldPid ? `process ${oldPid} stopped, ` : ''}process ${after.pid} answers at ${o.url}. Code: ${after.root}.${kept}` });
}

// The real Taskboard, or the sandbox whose TASKBOARD_DIR is set (a sandbox runs the code of this checkout).
export function targetFromEnv(env = process.env) {
  if (!env.TASKBOARD_DIR) return { tbDir: TB_DIR, appDir: APP, url: PROD_URL, env: {}, launchd: launchdLoaded(), kickstart: () => execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${LAUNCHD_LABEL}`]) };
  const keep = ['TASKBOARD_DIR', 'TASKBOARD_VAULT', 'TASKBOARD_PORT', 'TASKBOARD_TMUX_SOCKET', 'TASKBOARD_MACHINE_NAME'];
  return { tbDir: env.TASKBOARD_DIR, appDir: env.TASKBOARD_RESTART_APP || CHECKOUT, url: `http://127.0.0.1:${env.TASKBOARD_PORT || 4317}`,
    env: Object.fromEntries(keep.filter(k => env[k]).map(k => [k, env[k]])), launchd: false };
}

async function main() {
  const args = process.argv.slice(2);
  if (process.env.TASK_ID) {
    console.error('Only the user restarts Taskboard: in Settings → Taskboard server on the dashboard, or with tb restart in a terminal. The controller asks with tb restart, which waits for your approval on the dashboard.');
    process.exit(1);
  }
  const target = targetFromEnv();
  const confirm = async () => {
    if (!process.stdin.isTTY) { console.error('Run again with --yes to restart anyway.'); return false; }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Restart anyway? [y/N] '); rl.close();
    return /^y(es)?$/i.test(answer.trim());
  };
  const r = await restartTaskboard({ ...target, yes: args.includes('--yes'), confirm });
  (r.ok ? console.log : console.error)(r.message);
  // a sandbox started with `pnpm sandbox` records its process id; keep `pnpm sandbox stop` working
  if (r.ok && process.env.TASKBOARD_DIR) {
    const meta = join(dirname(target.tbDir), 'sandbox.json'), m = readJson(meta, null);
    if (m?.url === target.url && !m.devPids) writeFileSync(meta, JSON.stringify({ ...m, pid: r.newPid }, null, 2));
  }
  process.exit(r.code);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
