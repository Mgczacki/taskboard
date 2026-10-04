// A release must not remove a release folder that a running process uses, and Taskboard must not start its tmux
// server from such a folder (the outage of 4 October 2026: the tmux server of the socket taskboard ran from a removed
// release folder, and every new task session failed with "getcwd: cannot access parent directories").
// Covers scripts/cwd-check.mjs (lsof parsing, the prune plan, the tmux server folder), pruneReleases in
// scripts/lib.mjs with a real process, the start folder of the tmux server and the folder of a new pane in
// server/tmux.ts, server/tmux-health.ts, and the tmux check of pnpm doctor (tests/task-procs.test.ts covers tb run). Each tmux server here uses its own socket.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { cwdOf, parseLsof, planPrune, releasesInUse, tmuxFolderProblem, tmuxServerFolder } from '../scripts/cwd-check.mjs';
import { waitFor } from './helpers/wait-for.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-release-in-use-')));
const SOCKET = `tb-release-in-use-${process.pid}`;
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = SOCKET;
const killTmux = () => { try { execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch { /* none */ } };
after(() => { killTmux(); rmSync(root, { recursive: true, force: true }); });

const R = '/Users/me/.taskboard/releases';
// lsof -nP -u <uid> -a -d cwd,txt -Fpcfn for: the tmux server (cwd in release a), a node server (cwd in release c, its
// node-pty addon loaded from release c), and a shell outside the releases
const LSOF = [
  'p100', 'ctmux', 'fcwd', `n${R}/a`, 'ftxt', 'n/opt/homebrew/bin/tmux',
  'p200', 'cTaskboard Server', 'fcwd', `n${R}/c`, 'ftxt', `n${R}/c/node_modules/node-pty/build/Release/pty.node`,
  'p300', 'czsh', 'fcwd', 'n/Users/me', '',
].join('\n');

test('parseLsof reads the pid, command, descriptor and path of each file', () => {
  const files = parseLsof(LSOF);
  assert.equal(files.length, 5);
  assert.deepEqual(files[0], { pid: 100, command: 'tmux', fd: 'cwd', inode: undefined, path: `${R}/a` });
  assert.deepEqual(files[3], { pid: 200, command: 'Taskboard Server', fd: 'txt', inode: undefined, path: `${R}/c/node_modules/node-pty/build/Release/pty.node` });
});

test('releasesInUse names the release folders that processes use, with the process and the reason', () => {
  const used = releasesInUse(parseLsof(LSOF), R);
  assert.deepEqual([...used.keys()].sort(), ['a', 'c']);
  assert.deepEqual(used.get('a'), [{ pid: 100, command: 'tmux', fd: 'cwd' }]);
  assert.equal(used.get('c')!.length, 2);
});

test('planPrune keeps the newest, the current, the previous and the used releases', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  const plan = planPrune({ ids, current: 'i', previous: 'h', newest: 3, inUse: releasesInUse(parseLsof(LSOF), R) });
  assert.deepEqual(plan.remove, ['b', 'd', 'e', 'f']);
  const why = Object.fromEntries(plan.keep.map(k => [k.id, k.reasons.join('; ')]));
  assert.match(why.a, /process 100 \(tmux\) uses it \(working directory\)/);
  assert.match(why.c, /process 200 \(Taskboard Server\) uses it \(program file\)/);
  assert.match(why.h, /previous release, for pnpm rollback/);
  assert.match(why.i, /current release/);
  assert.match(why.g, /newest 3/);
  // an old previous release (after a rollback) is kept too
  assert.ok(!planPrune({ ids, current: 'i', previous: 'b', newest: 3, inUse: new Map() }).remove.includes('b'));
});

test('planPrune removes nothing when the process list could not be read', () => {
  const plan = planPrune({ ids: ['a', 'b', 'c'], current: 'c', newest: 1, inUse: null });
  assert.deepEqual(plan.remove, []);
  assert.match(plan.keep[0].reasons.join(), /could not be read/);
});

test('pruneReleases keeps a release folder that a real process has as its working directory', async () => {
  const { pruneReleases } = await import('../scripts/lib.mjs');
  const rel = join(root, 'releases');
  const ids = ['r1', 'r2', 'r3', 'r4', 'r5'];
  for (const [i, id] of ids.entries()) { mkdirSync(join(rel, id), { recursive: true }); writeFileSync(join(rel, id, 'RELEASE.json'), JSON.stringify({ id, created: `2026-10-0${i + 1}T00:00:00Z` })); }
  const p = spawn('sleep', ['60'], { cwd: join(rel, 'r1'), stdio: 'ignore' });
  try {
    await waitFor(async () => (await cwdOf(p.pid!))?.path === join(rel, 'r1'), { description: 'lsof to show the working directory of the sleep process' });
    const lines: string[] = [];
    const plan = await pruneReleases({ root: rel, current: 'r5', previous: 'r4', newest: 1, print: (l: string) => lines.push(l) });
    assert.deepEqual(plan.remove, ['r2', 'r3']);
    assert.ok(existsSync(join(rel, 'r1')) && !existsSync(join(rel, 'r2')) && !existsSync(join(rel, 'r3')));
    assert.ok(lines.some(l => l.startsWith('Kept release r1:') && l.includes(`process ${p.pid}`) && l.includes('working directory')), lines.join('\n'));
    assert.ok(lines.includes('Removed old release r2.'));
    // without a process list nothing is removed
    const none = await pruneReleases({ root: rel, current: 'r5', newest: 1, files: null, print: () => {} });
    assert.deepEqual(none.remove, []);
  } finally { p.kill(); }
});

test('tmux: the server starts in the home folder, and a pane starts in its folder when the tmux server folder was deleted', async t => {
  const tmux = await import('../server/tmux.ts');
  const good = join(root, 'good'); mkdirSync(good);
  // 1. A tmux server started by Taskboard runs from the home folder, even when the Node process works in another folder.
  const start = join(root, 'start'); mkdirSync(start);
  const before = process.cwd(); process.chdir(start);
  try { await tmux.newSession('first', good, {}, ['sleep', '60'], async () => {}); } finally { process.chdir(before); }
  const first = await tmuxServerFolder(SOCKET);
  assert.equal(first?.cwd, realpathSync(homedir()));
  assert.equal(first?.deleted, false);
  killTmux();

  // 2. A tmux server that an older Taskboard started from a folder that was then deleted (the state of 4 October).
  const gone = join(root, 'gone'); mkdirSync(gone);
  execFileSync('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'old', '-c', gone, 'sleep 60'], { cwd: gone });
  rmSync(gone, { recursive: true });
  const broken = await tmuxServerFolder(SOCKET);
  assert.equal(broken?.cwd, gone);
  assert.equal(broken?.deleted, true);
  assert.match(tmuxFolderProblem(broken, SOCKET)!, new RegExp(`tmux -L ${SOCKET} kill-server`));

  // tmux 3.7c ignores -c on such a server: a pane without the cd starts in the deleted folder (shown, not required)
  const out = join(root, 'cwd-plain.txt');
  await tmux.tmux('new-session', '-d', '-s', 'plain', '-c', good, 'node', '-e', `require('fs').writeFileSync(${JSON.stringify(out)}, (() => { try { return process.cwd(); } catch (e) { return e.code; } })())`);
  await waitFor(() => existsSync(out), { description: 'the plain pane to write its folder' });
  t.diagnostic(`pane started with -c only: ${readFileSync(out, 'utf8')}`);

  // newSession changes to the folder first (inFolder), so the agent command works there
  const out2 = join(root, 'cwd-task.txt');
  await tmux.newSession('task', good, {}, ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(out2)}, process.cwd())`], async () => {});
  await waitFor(() => existsSync(out2), { description: 'the task pane to write its folder' });
  assert.equal(readFileSync(out2, 'utf8'), good);

  // the server check (tmux-health.ts) finds it and names the sessions that a restart ends
  const health = await import('../server/tmux-health.ts');
  const h = await health.check();
  assert.equal(h?.pid, broken!.pid);
  assert.ok(h!.sessions.includes('old'), h!.sessions.join());
  assert.equal(h!.command, `tmux -L ${SOCKET} kill-server`);

  // pnpm doctor reports it (and exits with 1)
  let json = '';
  try { json = execFileSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'doctor.mjs'), '--json'], { env: { ...process.env, TB_LAUNCHD_LABEL: 'local.tbtest.release-in-use' }, encoding: 'utf8' }); assert.fail('doctor exited with 0'); }
  catch (e) { json = (e as { stdout?: string }).stdout || ''; }
  const d = JSON.parse(json);
  assert.equal(d.tmux.deleted, true);
  assert.equal(d.tmux.pid, broken!.pid);
  assert.match(d.tmux.problem, /runs from a deleted folder/);
  killTmux();
});

