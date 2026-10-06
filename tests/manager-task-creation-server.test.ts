import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('tb new places a manager task in its group and requires a choice for several groups', { timeout: 120000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-manager-new-')));
  const dir = join(root, 'state'), vault = join(root, 'vault'), work = join(root, 'work'), bin = join(root, 'bin');
  for (const path of [dir, join(vault, 'tasks'), join(vault, 'groups'), work, bin]) mkdirSync(path, { recursive: true });
  const socket = `tb-manager-new-${process.pid}`;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TASK_|TB_|TASKBOARD_)/.test(key))) as NodeJS.ProcessEnv;
  const agent = join(bin, 'claude');
  writeFileSync(agent, '#!/bin/sh\n[ "$1" = auth ] && { echo \'{"loggedIn":true,"email":"test@example.invalid"}\'; exit 0; }\nexec sleep 600\n');
  chmodSync(agent, 0o755);
  const accountDir = join(root, 'account'); mkdirSync(accountDir);
  writeFileSync(join(dir, 'accounts.json'), JSON.stringify([{ id: 'claude-test', agent: 'claude', name: 'Claude test', dir: accountDir, maxParallel: 20, created: new Date().toISOString() }]));
  writeFileSync(join(dir, 'machine.json'), JSON.stringify({ name: 'manager-new-test', controller: { autostart: false, remoteControl: false }, permissions: { controllerNeedsApproval: false, agentsNeedApproval: true, trustWorkspaces: false, autoReview: false } }));
  const time = new Date().toISOString();
  writeFileSync(join(vault, 'tasks', 'manager.md'), `---\nid: manager\nnum: 1\ntitle: Manager\nagent: claude\naccount: claude-test\nstatus: idle\ncwd: ${JSON.stringify(work)}\nfolder: ${JSON.stringify(work)}\nsession: manager-session\ncreated: ${time}\nupdated: ${time}\nstatusAt: ${time}\n---\nManager\n`);
  const groupNote = (id: string, manager: boolean) => writeFileSync(join(vault, 'groups', `${id}.md`), `---\nid: ${id}\nname: ${id}\ncolor: '#58a6ff'\ntasks:\n  - manager\ncreated: ${JSON.stringify(time)}\n${manager ? 'manager: manager\nmanagerPreset: create\n' : ''}---\n# ${id}\n`);
  groupNote('first', true); groupNote('second', false);
  const tmux = (...args: string[]) => spawnSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' });
  assert.equal(tmux('new-session', '-d', '-s', 'manager-session', 'sleep 600').status, 0);
  const port = await new Promise<number>(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolve(typeof address === 'object' && address ? address.port : 0)); }); });
  const url = `http://127.0.0.1:${port}`;
  const env = { ...clean, PATH: `${bin}:${process.env.PATH}`, TASKBOARD_PORT: String(port), TASKBOARD_DIR: dir, TASKBOARD_VAULT: vault, TASKBOARD_TMUX_SOCKET: socket, TASKBOARD_MACHINE_NAME: 'manager-new-test' };
  const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; server.stdout.on('data', data => output += data); server.stderr.on('data', data => output += data);
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) { try { ready = (await fetch(url + '/api/info')).ok; } catch { /* starting */ } if (ready) break; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.ok(ready, output);
    const taskToken = readFileSync(join(dir, 'task-tokens.json'), 'utf8');
    const managerToken = (JSON.parse(taskToken) as Record<string, string>).manager;
    const tb = (args: string[]) => new Promise<{ code: number | null; out: string }>(resolve => {
      const child = spawn(process.execPath, ['bin/tb', ...args], { cwd: process.cwd(), env: { ...env, TB_URL: url, TB_TOKEN_FILE: join(dir, 'token'), TB_TASK_TOKEN: managerToken, TASK_ID: 'manager' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; child.stdout.on('data', data => out += data); child.stderr.on('data', data => out += data);
      child.on('close', code => resolve({ code, out }));
    });
    const request = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(url + path, { method, headers: { 'content-type': 'application/json', origin: url }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    };
    const groupList = async () => (await request('GET', '/api/groups')).data as { id: string; tasks: string[] }[];
    const newTask = (title: string, group?: string) => tb(['new', '--agent', 'claude', '--account', 'claude-test', '--folder', work, '--no-worktree', '--title', title, ...(group ? ['--group', group] : []), 'Do the task.']);
    const taskId = (title: string, rows: { id: string; title: string }[]) => rows.find(task => task.title === title)?.id;
    const tasks = async () => (await request('GET', '/api/tasks')).data as { id: string; title: string; parent?: string }[];

    const first = await newTask('Default child');
    if (first.code === 2) {
      const pending = (await request('GET', '/api/approvals')).data as { id: string; action: string; state: string; summary: string }[];
      const card = pending.find(item => item.action === 'new' && item.state === 'pending' && item.summary.includes('Default child'));
      assert.ok(card);
      assert.equal((await request('POST', `/api/approvals/${card.id}/approve`, {})).status, 200);
    } else assert.equal(first.code, 0, first.out + output);
    const firstId = taskId('Default child', await tasks()); assert.ok(firstId);
    assert.equal((await tasks()).find(task => task.id === firstId)?.parent, 'manager');
    assert.ok((await groupList()).find(group => group.id === 'first')?.tasks.includes(firstId));
    assert.ok(!((await groupList()).find(group => group.id === 'second')?.tasks.includes(firstId)));
    const firstBoard = (await request('GET', '/api/board?group=first')).data as { columns: Record<string, { id: string }[]> };
    assert.ok(Object.values(firstBoard.columns).flat().some(task => task.id === firstId));
    const groupedIds = new Set((await groupList()).flatMap(group => group.tasks));
    const ungrouped = (await tasks()).filter(task => !groupedIds.has(task.id));
    assert.ok(!ungrouped.some(task => task.id === firstId));

    const assigned = await request('POST', '/api/manager/second', { task: 'manager', preset: 'create' });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.data));
    const ambiguous = await newTask('Needs a group');
    assert.equal(ambiguous.code, 1); assert.match(ambiguous.out, /manages more than one group.*--group/);
    assert.equal(taskId('Needs a group', await tasks()), undefined);
    const second = await newTask('Chosen child', 'second');
    assert.equal(second.code, 0, second.out + output);
    const secondId = taskId('Chosen child', await tasks()); assert.ok(secondId);
    assert.ok((await groupList()).find(group => group.id === 'second')?.tasks.includes(secondId));
    assert.ok(!((await groupList()).find(group => group.id === 'first')?.tasks.includes(secondId)));
    const secondBoard = (await request('GET', '/api/board?group=second')).data as { columns: Record<string, { id: string }[]> };
    assert.ok(Object.values(secondBoard.columns).flat().some(task => task.id === secondId));
    const outside = await newTask('Outside child', 'outside');
    assert.equal(outside.code, 1); assert.match(outside.out, /another group/);
    assert.equal(taskId('Outside child', await tasks()), undefined);

    const parked = await request('POST', `/api/tasks/${secondId}/status`, { status: 'parked' });
    assert.equal(parked.status, 200, JSON.stringify(parked.data));
    const events = JSON.parse(readFileSync(join(dir, 'manager-event-queue.json'), 'utf8')) as { group: string; task: string; kind: string }[];
    assert.ok(events.some(event => event.group === 'second' && event.task === secondId && event.kind === 'status'));

    assert.equal((await request('POST', '/api/manager/first', { task: null })).status, 200);
    assert.equal((await request('POST', '/api/manager/second', { task: 'manager', preset: 'direct' })).status, 200);
    const cardRequest = await newTask('Approved child');
    assert.equal(cardRequest.code, 2, cardRequest.out);
    assert.match(cardRequest.out, /Approval pending: card/);
    assert.equal(taskId('Approved child', await tasks()), undefined);
    const cards = (await request('GET', '/api/approvals')).data as { id: string; action: string; state: string; summary: string }[];
    const card = cards.find(item => item.action === 'new' && item.state === 'pending' && item.summary.includes('Approved child'));
    assert.ok(card);
    assert.equal((await request('POST', `/api/approvals/${card.id}/approve`, {})).status, 200);
    const approvedId = taskId('Approved child', await tasks()); assert.ok(approvedId);
    assert.ok((await groupList()).find(group => group.id === 'second')?.tasks.includes(approvedId));
  } finally {
    server.kill('SIGTERM'); if (server.exitCode === null) await once(server, 'exit');
    tmux('kill-server');
    rmSync(root, { recursive: true, force: true });
  }
});
