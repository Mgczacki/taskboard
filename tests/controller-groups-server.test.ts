import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('controller group and manager commands require its token and an exact user request', { timeout: 60000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-controller-groups-')));
  const tbdir = join(root, 'state'), vault = join(root, 'vault'), transcript = join(root, 'controller.jsonl');
  mkdirSync(tbdir); mkdirSync(join(vault, 'tasks'), { recursive: true });
  writeFileSync(join(tbdir, 'machine.json'), JSON.stringify({ name: 'groups-test', controller: { autostart: false, remoteControl: false } }));
  writeFileSync(transcript, '');
  const note = (id: string, num: number, extra = {}) => writeFileSync(join(vault, 'tasks', `${id}.md`),
    `---\n${Object.entries({ id, num, title: id, agent: 'claude', status: 'idle', folder: root, cwd: root, created: new Date().toISOString(), ...extra }).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n# ${id}\n`);
  note('controller', 0, { role: 'controller', transcript }); note('worker', 417);
  const userSays = (words: string) => writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: words } }) + '\n', { flag: 'a' });
  const port = await new Promise<number>(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolve(typeof address === 'object' && address ? address.port : 0)); }); });
  const base = `http://127.0.0.1:${port}`;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TASK_|TB_|TASKBOARD_)/.test(key)));
  const env = { ...clean, TASKBOARD_PORT: String(port), TASKBOARD_DIR: tbdir, TASKBOARD_VAULT: vault, TASKBOARD_TMUX_SOCKET: `tb-groups-${process.pid}`, TASKBOARD_MACHINE_NAME: 'groups-test' };
  const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; server.stdout.on('data', b => output += b); server.stderr.on('data', b => output += b);
  try {
    for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/api/info')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    assert.equal((await fetch(base + '/api/info')).status, 200, output);
    const token = readFileSync(join(tbdir, 'token'), 'utf8').trim();
    const controllerToken = readFileSync(join(tbdir, 'mail-controller.token'), 'utf8').trim();
    const ctl = { 'content-type': 'application/json', 'x-taskboard-token': token, 'x-tb-actor': 'controller', 'x-tb-mail-controller': controllerToken };
    const post = async (path: string, body: object, headers: Record<string, string>, method = 'POST') => {
      const response = await fetch(base + path, { method, headers, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    };
    const tb = (args: string[], actor = 'controller', withToken = true) => new Promise<{ code: number | null; out: string }>(resolve => {
      const child = spawn(process.execPath, ['bin/tb', ...args], { cwd: process.cwd(), env: { ...clean, TB_URL: base, TB_TOKEN_FILE: join(tbdir, 'token'), TASK_ID: actor, ...(withToken ? { TB_MAIL_CONTROLLER_TOKEN: controllerToken } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => out += b); child.on('close', code => resolve({ code, out }));
    });
    const createWords = 'Create Developer Experience with task #417.';
    assert.equal((await post('/api/groups', { name: 'Developer Experience', tasks: ['worker'], userRequest: createWords }, ctl)).status, 403);
    userSays(createWords);
    assert.equal((await post('/api/groups', { name: 'Developer Experience', tasks: ['worker'], userRequest: createWords }, { ...ctl, 'x-tb-mail-controller': 'wrong' })).status, 403);
    assert.equal((await post('/api/groups', { name: 'Developer Experience', tasks: ['missing'], userRequest: createWords }, ctl)).status, 400);
    assert.equal((await tb(['group', 'create', 'Developer Experience', '--task', '417', '--user-request', createWords], 'worker')).code, 1);
    const created = await tb(['group', 'create', 'Developer Experience', '--task', '417', '--user-request', createWords]);
    assert.equal(created.code, 0, created.out + output);
    assert.equal((await tb(['group', 'create', 'Developer Experience', '--task', '417', '--user-request', createWords])).code, 1);
    const groups = await (await fetch(base + '/api/groups')).json() as { id: string; tasks: string[]; manager?: string; managerPreset?: string }[];
    assert.deepEqual(groups[0].tasks, ['worker']);
    const removeTaskWords = 'Remove task #417 from Developer Experience.';
    userSays(removeTaskWords);
    assert.equal((await post(`/api/groups/${groups[0].id}`, { remove: ['worker'], userRequest: removeTaskWords }, { ...ctl, 'x-tb-mail-controller': 'wrong' }, 'PATCH')).status, 403);
    assert.equal((await tb(['group', 'rm', 'Developer Experience', '417', '--user-request', removeTaskWords])).code, 0);
    const addTaskWords = 'Add task #417 to Developer Experience.';
    assert.equal((await tb(['group', 'add', 'Developer Experience', '417', '--user-request', addTaskWords])).code, 1);
    userSays(addTaskWords);
    assert.equal((await tb(['group', 'add', 'Developer Experience', '417', '--user-request', addTaskWords])).code, 0);
    const setWords = 'Make task #417 the manager of Developer Experience with Watch only.';
    userSays(setWords);
    assert.equal((await post('/api/manager/Developer%20Experience', { task: 'worker', preset: 'watch', userRequest: setWords }, { ...ctl, 'x-tb-mail-controller': 'wrong' })).status, 403);
    assert.equal((await post('/api/manager/Developer%20Experience', { task: 'worker', preset: 'watch', userRequest: 'Make task #417 the manager of Developer Experience.' }, ctl)).status, 403);
    const set = await tb(['manager', 'set', '417', '--group', 'Developer Experience', '--preset', 'watch', '--user-request', setWords]);
    assert.equal(set.code, 0, set.out + output);
    assert.equal((await tb(['manager', 'set', '417', '--group', 'Developer Experience', '--preset', 'watch', '--user-request', setWords])).code, 1);
    const removeWords = 'Remove the manager of Developer Experience.';
    userSays(removeWords);
    const removed = await tb(['manager', 'remove', '--group', 'Developer Experience', '--user-request', removeWords]);
    assert.equal(removed.code, 0, removed.out + output);
    const final = await (await fetch(base + '/api/groups')).json() as { manager?: string }[];
    assert.equal(final[0].manager, undefined);
  } finally { server.kill('SIGTERM'); }
});
