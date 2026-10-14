import { TestResources } from './helpers/test-resources.ts';
const resources = new TestResources();
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('new tasks use the creator current group across API and tb batch paths', { timeout: 120000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-task-group-')));
  const dir = join(root, 'state'), vault = join(root, 'vault'), work = join(root, 'work'), bin = join(root, 'bin');
  for (const path of [dir, join(vault, 'tasks'), join(vault, 'groups'), work, bin]) mkdirSync(path, { recursive: true });
  writeFileSync(join(dir, 'machine.json'), JSON.stringify({ name: 'task-group-test', controller: { autostart: false, remoteControl: false }, permissions: { agentsNeedApproval: false, controllerNeedsApproval: false, trustWorkspaces: false } }));
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\n[ "$1" = auth ] && { echo \'{"loggedIn":true,"email":"test@example.com"}\'; exit 0; }\nexec sleep 600\n');
  chmodSync(join(bin, 'claude'), 0o755);
  const task = (id: string, num: number) => writeFileSync(join(vault, 'tasks', `${id}.md`),
    `---\nid: ${id}\nnum: ${num}\ntitle: ${id}\nagent: claude\nstatus: idle\nfolder: ${work}\ncwd: ${work}\ncreated: '2026-01-01T00:00:00.000Z'\n---\n# ${id}\n`);
  task('ordinary', 1); task('manager', 2); task('multi', 3); task('ungrouped', 4);
  const group = (id: string, tasks: string[], manager?: string) => writeFileSync(join(vault, 'groups', `${id}.md`),
    `---\nid: ${id}\nname: ${id}\ncolor: '#ffffff'\ntasks:\n${tasks.map(t => `  - ${t}`).join('\n')}\ncreated: '2026-01-01T00:00:00.000Z'\n${manager ? `manager: ${manager}\nmanagerPreset: create\n` : ''}---\n# ${id}\n`);
  group('alpha', ['ordinary', 'manager', 'multi'], 'manager'); group('beta', ['manager', 'multi']);
  const port = await new Promise<number>(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(() => resolve(typeof a === 'object' && a ? a.port : 0)); }); });
  const url = `http://127.0.0.1:${port}`;
  const socket = resources.socket(`tb-task-group-${process.pid}`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TASKBOARD_PORT: String(port), TASKBOARD_DIR: dir, TASKBOARD_VAULT: vault, TASKBOARD_TMUX_SOCKET: socket, TASKBOARD_MACHINE_NAME: 'task-group-test' };
  const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; server.stdout.on('data', b => output += b); server.stderr.on('data', b => output += b);
  try {
    for (let i = 0; i < 200; i++) { try { if ((await fetch(url + '/api/info')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    assert.equal((await fetch(url + '/api/info')).status, 200, output);
    const token = readFileSync(join(dir, 'token'), 'utf8').trim();
    const key = (id: string) => readFileSync(join(dir, 'task-tokens', id), 'utf8').trim();
    const post = async (id: string, title: string, extra: object = {}, claim = id) => {
      const r = await fetch(url + '/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json', 'x-taskboard-token': token, 'x-tb-task-token': key(id), 'x-tb-actor': claim }, body: JSON.stringify({ title, desc: title, agent: 'claude', folder: work, worktree: false, ...extra }) });
      return { status: r.status, body: await r.json() as { id?: string; parent?: string; error?: string } };
    };
    const members = async (id: string) => ((await (await fetch(url + '/api/groups')).json()) as { id: string; tasks: string[] }[]).find(g => g.id === id)!.tasks;
    const ordinary = await post('ordinary', 'ordinary-child');
    assert.equal(ordinary.status, 200, output); assert.ok((await members('alpha')).includes(ordinary.body.id!));
    const manager = await post('manager', 'manager-child');
    assert.equal(manager.status, 200, output); assert.equal(manager.body.parent, 'manager');
    assert.ok((await members('alpha')).includes(manager.body.id!)); assert.ok(!(await members('beta')).includes(manager.body.id!));
    const override = await post('ordinary', 'override-child', { group: 'beta' });
    assert.equal(override.status, 200, output); assert.ok((await members('beta')).includes(override.body.id!));
    assert.ok(!(await members('alpha')).includes(override.body.id!));
    const ungrouped = await post('ungrouped', 'ungrouped-child');
    assert.equal(ungrouped.status, 200, output);
    assert.ok(!(await members('alpha')).includes(ungrouped.body.id!)); assert.ok(!(await members('beta')).includes(ungrouped.body.id!));
    const ambiguous = await post('multi', 'ambiguous-child');
    assert.equal(ambiguous.status, 400); assert.match(ambiguous.body.error || '', /more than one group/);
    const selected = await post('multi', 'selected-child', { group: 'beta' });
    assert.equal(selected.status, 200, output); assert.ok((await members('beta')).includes(selected.body.id!));
    const outside = await post('manager', 'outside-child', { group: 'beta' });
    assert.equal(outside.status, 403); assert.match(outside.body.error || '', /another group/);
    const spoofed = await post('ordinary', 'spoofed-child', {}, 'manager');
    assert.equal(spoofed.status, 403);
    const plan = join(root, 'batch.json');
    writeFileSync(plan, JSON.stringify([
      { agent: 'claude', folder: work, title: 'batch-default', prompt: 'batch-default', worktree: false },
      { agent: 'claude', folder: work, title: 'batch-override', prompt: 'batch-override', group: 'beta', worktree: false },
    ]));
    const batch = await new Promise<{ code: number | null; output: string }>(resolve => {
      const child = spawn(process.execPath, ['bin/tb', 'new', '--batch', plan], { cwd: process.cwd(), env: { ...env, TB_URL: url, TB_TOKEN_FILE: join(dir, 'token'), TB_TASK_TOKEN: key('ordinary'), TASK_ID: 'ordinary' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => out += b); child.on('close', code => resolve({ code, output: out }));
    });
    assert.equal(batch.code, 0, batch.output + output);
    const all = await (await fetch(url + '/api/tasks')).json() as { id: string; title: string }[];
    const id = (title: string) => all.find(t => t.title === title)!.id;
    assert.ok((await members('alpha')).includes(id('batch-default')));
    assert.ok((await members('beta')).includes(id('batch-override')));
    const single = await new Promise<{ code: number | null; output: string }>(resolve => {
      const child = spawn(process.execPath, ['bin/tb', 'new', '--agent', 'claude', '--folder', work, '--no-worktree', '--title', 'cli-single', 'cli-single'],
        { cwd: process.cwd(), env: { ...env, TB_URL: url, TB_TOKEN_FILE: join(dir, 'token'), TB_TASK_TOKEN: key('ordinary'), TASK_ID: 'ordinary' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => out += b); child.on('close', code => resolve({ code, output: out }));
    });
    assert.equal(single.code, 0, single.output + output);
    const afterSingle = await (await fetch(url + '/api/tasks')).json() as { id: string; title: string }[];
    assert.ok((await members('alpha')).includes(afterSingle.find(t => t.title === 'cli-single')!.id));
    const move = await fetch(url + '/api/groups/move', { method: 'POST', headers: { 'content-type': 'application/json', origin: url },
      body: JSON.stringify({ taskId: 'ordinary', fromId: 'alpha', toId: 'beta' }) });
    assert.equal(move.status, 200, await move.text());
    const park = await fetch(url + `/api/tasks/${ordinary.body.id}/status`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify({ status: 'parked' }) });
    assert.equal(park.status, 200, await park.text());
    const afterMove = await post('ordinary', 'after-move-child');
    assert.equal(afterMove.status, 200, JSON.stringify(afterMove.body) + output);
    assert.ok((await members('beta')).includes(afterMove.body.id!));
    const alpha = await members('alpha'), beta = await members('beta');
    assert.ok(alpha.includes(ordinary.body.id!));
    assert.ok(beta.includes(override.body.id!));
    assert.match(readFileSync(join(dir, 'manager-events.jsonl'), 'utf8'), /ordinary-child.*joined the group/);
  } finally {
    server.kill('SIGTERM');
    if (server.exitCode === null) await once(server, 'exit');
    try { const { execFileSync } = await import('node:child_process'); execFileSync('tmux', ['-L', socket, 'kill-server']); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});
