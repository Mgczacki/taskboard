// The server keeps running when a terminal cannot attach, and records why it stopped. Every server here is a test
// server of this checkout: its own TASKBOARD_DIR, vault, port and tmux socket in the system temp folder, no controller
// and no launchd. Nothing touches ~/.taskboard or the tmux socket "taskboard".
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const checkout = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'tb-crash-'));
const socket = `tbcrash-${process.pid}`;
const pids: number[] = [];
after(() => {
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* ended */ } }
  try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* none */ }
  rmSync(root, { recursive: true, force: true });
});
const env: NodeJS.ProcessEnv = { ...process.env }; delete env.TASK_ID; delete env.TB_URL; delete env.TB_TOKEN_FILE;
const freePort = () => new Promise<number>(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 30000): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v as T; await new Promise(r => setTimeout(r, 200)); }
  return null;
}

interface Server { pid: number; url: string; token: string; dir: string; log: string }
// shell: commands that run before the server in the same shell (for example a lower descriptor limit)
async function start(name: string, port: number, shell = ''): Promise<Server> {
  const dir = join(root, name);
  mkdirSync(join(dir, 'tbdir'), { recursive: true }); mkdirSync(join(dir, 'vault', 'tasks'), { recursive: true });
  writeFileSync(join(dir, 'tbdir', 'machine.json'), JSON.stringify({ name: 'crash-test', controller: { autostart: false, remoteControl: false } }));
  const log = join(dir, 'server.log');
  const sbEnv = { ...env, TASKBOARD_DIR: join(dir, 'tbdir'), TASKBOARD_VAULT: join(dir, 'vault'), TASKBOARD_PORT: String(port), TASKBOARD_TMUX_SOCKET: socket, TASKBOARD_MACHINE_NAME: 'crash-test' };
  const tsx = join(checkout, 'node_modules', '.bin', 'tsx');
  const child = spawn('/bin/sh', ['-c', `${shell} exec "${tsx}" server/index.ts >> "${log}" 2>&1`], { cwd: checkout, env: sbEnv, detached: true, stdio: 'ignore' });
  child.unref();
  const url = `http://127.0.0.1:${port}`;
  const info = await waitFor(async () => { try { const r = await fetch(url + '/api/info', { signal: AbortSignal.timeout(2000) }); return r.ok ? r.json() as Promise<{ pid: number }> : null; } catch { return null; } });
  assert.ok(info, `the test server did not start; log ${log}`);
  pids.push(info.pid);
  return { pid: info.pid, url, token: readFileSync(join(dir, 'tbdir', 'token'), 'utf8').trim(), dir, log };
}
const term = (s: Server, session: string) => new WebSocket(`${s.url.replace('http', 'ws')}/ws/term?session=${session}&cols=80&rows=24`, { headers: { 'x-taskboard-token': s.token } });
const closed = (ws: WebSocket) => new Promise<{ code: number; reason: string }>(resolve => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
const opened = (ws: WebSocket) => new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
const lsof = (pid: number) => { try { return execFileSync('lsof', ['-p', String(pid)], { encoding: 'utf8' }).split('\n'); } catch { return []; } };
const counts = (pid: number) => { const l = lsof(pid); return { all: l.length - 1, ptmx: l.filter(x => /ptmx/.test(x)).length, revoked: l.filter(x => /revoked/.test(x)).length, kqueue: l.filter(x => /KQUEUE/.test(x)).length }; };

test('terminals: a missing session, a too large message, and 30 terminals that open and close', { timeout: 120000 }, async () => {
  const s = await start('main', await freePort());
  execFileSync('tmux', ['-L', socket, 'new-session', '-d', '-s', 'util-soak', 'sleep 600']);

  // a tmux session that does not exist: the attach ends at once, and the server says so with code 4001
  const missing = await closed(term(s, 'util-nosuch'));
  assert.equal(missing.code, 4001);
  assert.equal(missing.reason, 'the tmux session is not running');

  // a message larger than maxPayload (1 MB): ws emits 'error' on the socket; the server must keep running
  const big = term(s, 'util-soak'); await opened(big);
  big.on('error', () => {});
  const bigEnd = closed(big);
  big.send('x'.repeat(2 * 1024 * 1024));
  assert.equal((await bigEnd).code, 1009);
  assert.ok(alive(s.pid));

  // soak: 30 terminals open, receive output, close; three rounds
  await new Promise(r => setTimeout(r, 500));
  const before = counts(s.pid);
  for (let round = 0; round < 3; round++) {
    const list = Array.from({ length: 30 }, () => term(s, 'util-soak'));
    await Promise.all(list.map(opened));
    await new Promise(r => setTimeout(r, 300));
    const ends = list.map(closed);
    list.forEach(ws => ws.close());
    await Promise.all(ends);
  }
  await new Promise(r => setTimeout(r, 1500));
  const afterSoak = counts(s.pid);
  console.log(`descriptors of the test server: before ${JSON.stringify(before)}, after 90 attaches ${JSON.stringify(afterSoak)}`);
  assert.equal(afterSoak.ptmx, before.ptmx, 'no pseudo-terminal stays open');
  assert.equal(afterSoak.revoked, before.revoked, 'no slave side stays open');
  // node-pty 1.2.0 closes every descriptor of a spawn (1.1.0 left one kqueue for each; see server/pty-spawn.ts)
  assert.equal(afterSoak.kqueue, before.kqueue, 'no kqueue stays open');
  assert.ok(afterSoak.all - before.all <= 5, `${afterSoak.all - before.all} more descriptors after 90 attaches`);
  const text = readFileSync(s.log, 'utf8');
  assert.doesNotMatch(text, /Unhandled pty write error/);
  assert.doesNotMatch(text, /crashed:/);
  assert.ok(alive(s.pid));
  process.kill(s.pid, 'SIGTERM');
  await waitFor(() => !alive(s.pid), 10000);
});

test('no free descriptor: the terminal gets code 1013 and the server keeps running', { timeout: 120000 }, async () => {
  // a hard limit of 160 descriptors (Node cannot raise its soft limit above it); each terminal uses 3 or 4 of them
  const s = await start('limit', await freePort(), 'ulimit -n 160;');
  execFileSync('tmux', ['-L', socket, 'new-session', '-d', '-s', 'util-limit', 'sleep 600']);
  const list: WebSocket[] = [];
  let failure: { code: number; reason: string } | null = null;
  for (let i = 0; i < 80 && !failure; i++) {
    const ws = term(s, 'util-limit'); list.push(ws);
    ws.on('error', () => {});
    const end = closed(ws);
    const r = await Promise.race([opened(ws).then(() => new Promise(res => setTimeout(res, 150))).then(() => null), end]).catch(() => null);
    if (r && (r as { code: number }).code === 1013) failure = r as { code: number; reason: string };
  }
  assert.ok(failure, 'no terminal hit the descriptor limit');
  assert.equal(failure.reason, 'could not open a terminal');
  assert.match(readFileSync(s.log, 'utf8'), /could not attach a terminal to util-limit: (posix_spawnp failed|open slave pty failed|posix_openpt failed)/);
  for (const ws of list) ws.close();
  await new Promise(r => setTimeout(r, 1500));
  assert.ok(alive(s.pid), 'the server still runs');
  // with the descriptors free again, a terminal opens
  const again = term(s, 'util-limit');
  await opened(again);
  again.close();
  process.kill(s.pid, 'SIGTERM');
  await waitFor(() => !alive(s.pid), 10000);
});

test('the start history names a restart and a SIGKILL; dashboards hear that the server stops', { timeout: 120000 }, async () => {
  const port = await freePort();
  const a = await start('history', port);
  const events = new WebSocket(`${a.url.replace('http', 'ws')}/ws/events`, { headers: { 'x-taskboard-token': a.token } });
  const messages: { type: string; reason?: string }[] = [];
  events.on('message', m => messages.push(JSON.parse(m.toString())));
  await opened(events);
  // what scripts/restart.mjs writes before it stops the server
  writeFileSync(join(a.dir, 'tbdir', 'restart-intent.json'), JSON.stringify({ reason: 'manual', at: new Date().toISOString(), detail: 'restart from the dashboard or tb restart' }));
  process.kill(a.pid, 'SIGTERM');
  await waitFor(() => !alive(a.pid), 10000);
  assert.deepEqual(messages.filter(m => m.type === 'stopping').map(m => m.reason), ['manual']);

  const b = await start('history', port);
  const hb = await (await fetch(b.url + '/api/server')).json();
  assert.equal(hb.previous.kind, 'manual');
  assert.equal(hb.pid, b.pid);
  process.kill(b.pid, 'SIGKILL');
  await waitFor(() => !alive(b.pid), 10000);

  const c = await start('history', port);
  const hc = await (await fetch(c.url + '/api/server')).json();
  assert.equal(hc.previous.kind, 'unknown');
  assert.deepEqual(hc.starts.map((x: { pid: number }) => x.pid), [c.pid, b.pid, a.pid]);
  assert.equal(hc.counts.manual, 1);
  assert.equal(hc.planned, 1);
  assert.match(readFileSync(c.log, 'utf8'), /stopping: received SIGTERM \(process \d+\); reason: manual/);
  assert.match(readFileSync(c.log, 'utf8'), /started: process \d+, release .*; the previous server ended: unknown/);
  process.kill(c.pid, 'SIGTERM');
  await waitFor(() => !alive(c.pid), 10000);
});
