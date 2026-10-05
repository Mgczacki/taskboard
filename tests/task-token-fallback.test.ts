// Sessions launched before the release that added TB_TASK_TOKEN (task 275). Such a session keeps its old environment:
// TASK_ID is set, TB_TOKEN_FILE is the shared ~/.taskboard/token and TB_TASK_TOKEN is missing. Covers, on a test
// Taskboard server with its own port, folders and tmux socket (nothing here uses the real Taskboard):
// - the server writes a token file (mode 0600) for each task at start, and none for the controller
// - tb reads the token from TB_TASK_TOKEN, else from that file, and then acts as its task (a card for tb send and tb new)
// - tb with TASK_ID and no token stops with a message and sends nothing
// - the server refuses a request that names a task in x-tb-actor without that task's token, or with another task's token
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-token-fallback-')));
const tbdir = join(root, 'tbdir'), vault = join(root, 'vault'), workspace = join(root, 'workspace'), home = join(root, 'home');
for (const d of [tbdir, join(vault, 'tasks'), workspace, home]) mkdirSync(d, { recursive: true });
const socket = `tb-token-fallback-${process.pid}`;
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TASK_|TB_|TASKBOARD_)/.test(k))) as NodeJS.ProcessEnv;
const taskNote = (f: Record<string, string | number | boolean>) => writeFileSync(join(vault, 'tasks', `${f.id}.md`),
  `---\n${Object.entries({ created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z', statusAt: '2026-01-01T00:00:00.000Z', ...f }).map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`).join('\n')}\n---\n# ${f.title}\n`);
const testAccounts = [{ id: 'claude-test', agent: 'claude', name: 'claude', dir: join(root, 'accounts', 'claude'), isDefault: false, maxParallel: 8, created: new Date().toISOString() }];
mkdirSync(testAccounts[0].dir, { recursive: true });
writeFileSync(join(tbdir, 'accounts.json'), JSON.stringify(testAccounts));
// old: no token yet (as a task from before the release); known: a token already in task-tokens.json; both parked
taskNote({ id: 'old', num: 30, title: 'Old session', agent: 'claude', account: 'claude-test', status: 'parked', cwd: workspace, folder: workspace, session: 'old' });
taskNote({ id: 'known', num: 31, title: 'Known task', agent: 'claude', account: 'claude-test', status: 'parked', cwd: workspace, folder: workspace, session: 'known' });
taskNote({ id: 'controller', num: 0, title: 'Controller', agent: 'claude', role: 'controller', status: 'idle', cwd: workspace, folder: workspace, session: 'controller' });
writeFileSync(join(tbdir, 'task-tokens.json'), JSON.stringify({ known: 'e'.repeat(64) }));
writeFileSync(join(tbdir, 'machine.json'), JSON.stringify({ name: 'token-test', controller: { autostart: false, remoteControl: false } }));
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (check: () => boolean | Promise<boolean>, ms = 15000) => { for (let i = 0; i < ms / 100; i++) { if (await check()) return true; await pause(100); } return false; };

test('a session without TB_TASK_TOKEN reads its token file, and a task without its token never acts as the user', { timeout: 120000 }, async () => {
  const port = await new Promise<number>(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => resolve(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  const env = { ...clean, HOME: home, TASKBOARD_PORT: String(port), TASKBOARD_DIR: tbdir, TASKBOARD_VAULT: vault, TASKBOARD_TMUX_SOCKET: socket, TASKBOARD_MACHINE_NAME: 'token-test' };
  const child = spawn(join(process.cwd(), 'node_modules/.bin/tsx'), ['server/index.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b.toString(); }); child.stderr.on('data', b => { output += b.toString(); });
  try {
    assert.ok(await until(async () => { if (child.exitCode !== null) throw new Error(output); try { return (await fetch(base + '/api/info')).ok; } catch { return false; } }), output);
    const shared = join(tbdir, 'token');

    // 1. the server start wrote a token file for each task, readable only by the user, and none for the controller
    for (const id of ['old', 'known']) {
      const f = join(tbdir, 'task-tokens', id);
      assert.ok(existsSync(f), `token file for ${id}`);
      assert.equal(statSync(f).mode & 0o777, 0o600);
    }
    assert.equal(readFileSync(join(tbdir, 'task-tokens', 'known'), 'utf8'), 'e'.repeat(64), 'an existing token is kept');
    assert.ok(!existsSync(join(tbdir, 'task-tokens', 'controller')));
    const tokens = JSON.parse(readFileSync(join(tbdir, 'task-tokens.json'), 'utf8'));
    assert.deepEqual(Object.keys(tokens).sort(), ['known', 'old']);

    const tb = (args: string[], extra: Record<string, string | undefined>) => new Promise<{ code: number | null; out: string }>(resolve => {
      const p = spawn(process.execPath, ['bin/tb', ...args], { cwd: process.cwd(), env: { ...clean, HOME: home, TB_URL: base, ...extra } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; p.stdout.on('data', b => { out += b; }); p.stderr.on('data', b => { out += b; }); p.on('close', code => resolve({ code, out }));
    });
    const notes = async () => (await (await fetch(base + '/api/notes', { headers: { origin: base } })).json()) as { task?: string; subject: string }[];
    const cards = async () => ((await (await fetch(base + '/api/approvals')).json()) as { state: string; actor: string; summary: string }[]).filter(a => a.state === 'pending');

    // 2. the environment of a new session: TB_TASK_TOKEN is set
    const fresh = await tb(['mail', 'submit', 'From env', 'body'], { TASK_ID: 'known', TB_TOKEN_FILE: join(tbdir, 'task-tokens', 'known'), TB_TASK_TOKEN: 'e'.repeat(64) });
    assert.equal(fresh.code, 0, fresh.out);
    assert.equal((await notes()).find(n => n.subject === 'From env')?.task, 'known');

    // 3. the environment of an old session: the shared token file and no TB_TASK_TOKEN. tb reads task-tokens/old.
    const oldEnv = { TASK_ID: 'old', TB_TOKEN_FILE: shared };
    const mail = await tb(['mail', 'submit', 'From file', 'body'], oldEnv);
    assert.equal(mail.code, 0, mail.out);
    assert.equal((await notes()).find(n => n.subject === 'From file')?.task, 'old');
    // tb send and tb new from the old session wait for a card with the task as actor; they do not run as the user
    const send = await tb(['send', '31', 'hello'], oldEnv);
    assert.equal(send.code, 2, send.out);
    assert.match(send.out, /Approval pending: card/);
    const created = await tb(['new', '--agent', 'claude', '--folder', workspace, '--no-worktree', '--title', 'Spawned', 'do nothing'], oldEnv);
    assert.equal(created.code, 2, created.out);
    assert.doesNotMatch(created.out, /Started #/);
    assert.deepEqual((await cards()).map(c => c.actor), ['old', 'old']);

    // 4. TASK_ID without any token: tb stops before it sends a request
    mkdirSync(join(root, 'empty'), { recursive: true });
    const before = (await notes()).length;
    const none = await tb(['mail', 'submit', 'No token', 'body'], { TASK_ID: 'ghost', TB_TOKEN_FILE: join(root, 'empty', 'token') });
    assert.equal(none.code, 1);
    assert.match(none.out, /This session has no task token\. Park and resume the task, or ask the controller\./);
    assert.equal((await notes()).length, before, 'no request reached the server');

    // 5. the server: a request that names a task without its token, with a wrong token, or with another task's token
    const token = readFileSync(shared, 'utf8').trim();
    const post = (headers: Record<string, string>) => fetch(base + '/api/tasks/known/send', { method: 'POST', headers: { 'content-type': 'application/json', 'x-taskboard-token': token, ...headers }, body: JSON.stringify({ text: 'x' }) });
    const claimOnly = await post({ 'x-tb-actor': 'old' });
    assert.equal(claimOnly.status, 403);
    assert.match((await claimOnly.json()).error, /Task identity requires its token\. This session has no task token/);
    const wrong = await post({ 'x-tb-actor': 'old', 'x-tb-task-token': 'f'.repeat(64) });
    assert.equal(wrong.status, 403);
    assert.equal((await wrong.json()).error, 'Task token is not valid.');
    const other = await post({ 'x-tb-actor': 'old', 'x-tb-task-token': 'e'.repeat(64) });
    assert.equal(other.status, 403);
    assert.equal((await other.json()).error, 'The task token belongs to another task.');
    assert.equal((await cards()).length, 2, 'no new card from the refused requests');
  } finally {
    child.kill();
    spawnSync('tmux', ['-L', socket, 'kill-server']);
  }
});
