// The browsers and processes of each task (server/runtime-summary.ts, runtime-routes.ts) and the text the dashboard
// shows for them (web/src/runtimeText.ts). The route test runs a test server with its own port, folders and tmux socket.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { countText, mb, sumCounts, totalText } from '../web/src/runtimeText.ts';

test('countText shows nothing when nothing runs, and names browsers and processes', () => {
  assert.equal(countText(undefined), '');
  assert.equal(countText({ browser: 0, procs: 0 }), '');
  assert.equal(countText({ browser: 1, procs: 0 }), '1 browser');
  assert.equal(countText({ browser: 1, procs: 2 }), '1 browser · 2 processes');
  assert.equal(countText({ browser: 0, procs: 1 }), '1 process');
});

test('sumCounts adds up only the tasks that are asked for', () => {
  const counts = { a: { browser: 1, procs: 2 }, b: { browser: 0, procs: 1 }, c: { browser: 1, procs: 5 } };
  assert.deepEqual(sumCounts(counts, ['a', 'b', 'missing']), { browser: 1, procs: 3 });
  assert.deepEqual(sumCounts(counts, []), { browser: 0, procs: 0 });
});

test('memory text uses MB below 1 GB, and a dash when it is unknown', () => {
  assert.equal(mb(null), '—');
  assert.equal(mb(312), '312 MB');
  assert.equal(mb(1536), '1.5 GB');
  assert.equal(totalText({ browsers: 1, procs: 2, memMb: 400 }), '1 browser and 2 processes running · about 400 MB');
});

test('memory falls back to the sum of RSS when footprint cannot read the processes, and total counts only running items', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-rt-unit-')));
  process.env.TASKBOARD_DIR = join(root, 'state'); process.env.TASKBOARD_VAULT = join(root, 'vault');
  mkdirSync(process.env.TASKBOARD_DIR);
  writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ controller: { autostart: false, remoteControl: false } }));
  const summary = await import('../server/runtime-summary.ts');
  const memory = await import('../server/memory.ts');
  // process ids that do not exist: footprint fails, so the number is the sum of RSS of the group
  const ps = memory.parsePs(' 999999991  999999990  2048\n 999999992  999999990  1024\n 999999993  999999980   512\nbad line\n');
  assert.equal(ps.length, 3);
  const mem = await memory.byGroup([999999990, 999999970], ps);
  assert.equal(summary.memMb(mem, 999999990), 3);
  assert.equal(summary.memMb(mem, 999999970), null, 'a process group that ps does not list has no number');
  assert.equal(summary.memMb(mem, undefined), null);
  const t = summary.total([
    { task: 'a', kind: 'browser', name: 'Browser', state: 'running', memMb: 300 },
    { task: 'a', kind: 'proc', name: 'web', state: 'running', memMb: 50 },
    { task: 'b', kind: 'proc', name: 'db', state: 'exited', memMb: null },
    { task: 'b', kind: 'browser', name: 'Browser', state: 'stopped', memMb: null },
  ]);
  assert.deepEqual(t, { browsers: 1, procs: 1, memMb: 350 });
});

test('memory of a real process group is a positive number, below the sum of RSS on macOS', async () => {
  const memory = await import('../server/memory.ts');
  const ps = await memory.processes();
  const me = ps.find(p => p.pid === process.pid);
  assert.ok(me, 'ps lists this test process');
  const mb = (await memory.byGroup([me.pgid], ps)).get(me.pgid);
  assert.ok(mb && mb > 0);
  const rssMb = Math.round(ps.filter(p => p.pgid === me.pgid).reduce((n, p) => n + p.rssKb, 0) / 1024);
  if (process.platform === 'darwin') assert.ok(mb <= rssMb, `footprint ${mb} MB is not above the sum of RSS ${rssMb} MB`);
  else assert.equal(mb, rssMb);
});

test('a group lists the processes of its tasks, a task that leaves takes its items along, and deleting the group stops nothing', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-rt-route-')));
  const tbdir = join(root, 'tbdir'), vault = join(root, 'vault'), work = join(root, 'work');
  mkdirSync(tbdir); mkdirSync(join(vault, 'tasks'), { recursive: true }); mkdirSync(work);
  writeFileSync(join(tbdir, 'machine.json'), JSON.stringify({ controller: { autostart: false, remoteControl: false } }));
  for (const [id, num] of [['rt-a', 1], ['rt-b', 2]] as const)
    writeFileSync(join(vault, 'tasks', `${id}.md`), `---\nid: ${id}\nnum: ${num}\ntitle: Task ${num}\nagent: claude\nstatus: idle\ncwd: ${work}\nfolder: ${work}\nsession: tb-rt-${id}\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\nstatusAt: 2026-01-01T00:00:00.000Z\n---\n# Task ${num}\n`);
  const port = await new Promise<number>(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => resolve(p)); }); });
  const socket = `tb-rt-route-${port}`;
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(join(process.cwd(), 'node_modules/.bin/tsx'), ['server/index.ts'], { cwd: process.cwd(),
    env: { ...process.env, TASKBOARD_PORT: String(port), TASKBOARD_DIR: tbdir, TASKBOARD_VAULT: vault, TASKBOARD_TMUX_SOCKET: socket, TASKBOARD_MACHINE_NAME: 'runtime-test' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  try {
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { if ((await fetch(base + '/api/info')).ok) break; } catch { /* the server starts */ }
      await new Promise(r => setTimeout(r, 100));
    }
    const token = readFileSync(join(tbdir, 'token'), 'utf8').trim();
    const headers = { 'content-type': 'application/json', 'x-taskboard-token': token };
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      return { status: r.status, data: text && r.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null };
    };
    const sleeper = 'python3 -c "import time; time.sleep(300)"';
    assert.equal((await call('POST', '/api/tasks/rt-a/procs', { name: 'web', command: sleeper })).status, 200, output);
    assert.equal((await call('POST', '/api/tasks/rt-b/procs', { name: 'db', command: sleeper })).status, 200, output);
    const g = (await call('POST', '/api/groups', { name: 'Runtime test', tasks: ['rt-a', 'rt-b'] })).data;
    assert.ok(g.id, 'the group was created');
    assert.equal((await call('GET', `/api/groups/${g.id}/procs`)).status, 404, 'a group has no processes of its own');

    // the group view asks for the items of the group's tasks; each item names its task
    const ids = (await call('GET', '/api/groups')).data.find((x: { id: string }) => x.id === g.id).tasks as string[];
    let list = (await call('GET', `/api/runtime?tasks=${ids.join(',')}`)).data;
    assert.deepEqual(list.items.map((i: { task: string; name: string }) => `${i.task}/${i.name}`).sort(), ['rt-a/web', 'rt-b/db']);
    for (const i of list.items) { assert.equal(i.kind, 'proc'); assert.equal(typeof i.memMb, 'number', 'ps gives each running process a memory number'); }
    assert.equal(list.total.procs, 2);
    assert.equal(list.total.browsers, 0);
    const procs = (await call('GET', '/api/tasks/rt-a/procs')).data;
    assert.equal(typeof procs[0].memMb, 'number', 'the Processes tab gets the memory too');
    let counts = (await call('GET', '/api/runtime/counts')).data;
    assert.deepEqual(counts, { 'rt-a': { browser: 0, procs: 1 }, 'rt-b': { browser: 0, procs: 1 } });

    // a task that leaves the group takes its items out of the group view
    await call('PATCH', `/api/groups/${g.id}`, { remove: ['rt-b'] });
    const left = (await call('GET', '/api/groups')).data.find((x: { id: string }) => x.id === g.id).tasks as string[];
    list = (await call('GET', `/api/runtime?tasks=${left.join(',')}`)).data;
    assert.deepEqual(list.items.map((i: { task: string }) => i.task), ['rt-a']);

    // deleting the group stops nothing
    assert.equal((await call('DELETE', `/api/groups/${g.id}`)).status, 200);
    list = (await call('GET', '/api/runtime?tasks=rt-a,rt-b')).data;
    assert.deepEqual(list.items.map((i: { state: string }) => i.state), ['running', 'running']);

    // a stop acts on one item of one task
    await call('POST', '/api/tasks/rt-a/procs/web/stop', {});
    counts = (await call('GET', '/api/runtime/counts')).data;
    assert.deepEqual(counts, { 'rt-b': { browser: 0, procs: 1 } });
    await call('POST', '/api/tasks/rt-b/procs/db/stop', {});
    assert.deepEqual((await call('GET', '/api/runtime/counts')).data, {});
  } finally {
    child.kill();
    try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* no server */ }
  }
});
