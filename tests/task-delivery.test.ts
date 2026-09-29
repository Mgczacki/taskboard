import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';

const root = mkdtempSync(join(tmpdir(), 'tb-delivery-'));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-delivery-${process.pid}`;
process.env.CODEX_HOME = join(root, 'codex');
mkdirSync(process.env.CODEX_HOME, { recursive: true });
const bin = join(root, 'bin'); mkdirSync(bin, { recursive: true });
const fake = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
if (process.argv.includes('app-server')) {
  const rl = require('node:readline').createInterface({ input: process.stdin });
  rl.on('line', line => { const msg = JSON.parse(line);
    if (msg.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));
    if (msg.id === 2) console.log(JSON.stringify({ id: 2, result: { data: [{ hooks: [{ source: 'sessionFlags', eventName: 'preToolUse', command: 'node "$TB_HOOKS_DIR/guard.mjs"', key: '/<session-flags>/config.toml:pre_tool_use:0:0', currentHash: 'sha256:' + 'a'.repeat(64) }] }] } }));
  });
} else {
  console.log(process.env.TEST_QUESTION === '1' ? 'Do you trust the contents of this project?' : '>');
  process.stdin.on('data', chunk => fs.appendFileSync(path.join(process.env.TASK_DIR, 'input.txt'), chunk));
  setInterval(() => {}, 1000);
}
`;
for (const name of ['claude', 'codex', 'agy']) writeFileSync(join(bin, name), fake, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
mkdirSync(process.env.TASKBOARD_DIR, { recursive: true });
writeFileSync(join(process.env.TASKBOARD_DIR, 'accounts.json'), JSON.stringify([{ id: 'codex-fixture', agent: 'codex', name: 'Codex fixture', dir: process.env.CODEX_HOME, maxParallel: 8, created: new Date().toISOString() }]));
writeFileSync(join(process.env.TASKBOARD_DIR, 'machine.json'), JSON.stringify({ controller: { autostart: false }, permissions: { trustWorkspaces: false } }));
const store = await import('../server/store.ts');
const agents = await import('../server/agents.ts');
const tmux = await import('../server/tmux.ts');
const accounts = await import('../server/accounts.ts');
const docs = await import('../server/docs.ts');
const { mountReview } = await import('../server/review.ts');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const task = (agent: 'claude' | 'codex' | 'antigravity', num: number, sessionId?: string) => store.create({
  id: `delivery-${num}`, num, title: 'Delivery fixture', agent, status: 'stopped',
  cwd: root, folder: root, session: `task-${num}`, sessionId, account: agent === 'codex' ? 'codex-fixture' : undefined, desc: ''
});

test('review feedback keeps comments open when a stopped task cannot resume', async () => {
  const t = task('claude', 1);
  const path = join(docs.outboxDir(t.id), 'note.md');
  mkdirSync(docs.outboxDir(t.id), { recursive: true }); writeFileSync(path, '# Note\n');
  const app = express(); app.use(express.json()); mountReview(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (route: string, body: object) => {
    const response = await fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  try {
    const item = (await post('/api/review/request', { task: t.id, path })).data;
    await post(`/api/review/${item.id}/comment`, { block: -1, text: 'Revise it.' });
    const result = await post(`/api/review/${item.id}/feedback`, {});
    assert.equal(result.status, 409);
    assert.match(result.data.error, /No session id/);
    assert.equal(store.get(t.id)?.status, 'review');
    const saved = JSON.parse(readFileSync(join(root, 'state', 'reviews.json'), 'utf8'))[item.id];
    assert.equal(saved.state, 'pending');
    assert.equal(saved.comments[0].sent, undefined);
    assert.match(readFileSync(result.data.path, 'utf8'), /Revise it/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('stopped Claude Code, Codex, and Antigravity tasks resume before delivery', async () => {
  try {
    for (const [i, agent] of (['claude', 'codex', 'antigravity'] as const).entries()) {
      const t = task(agent, i + 2, `fixture-${agent}`);
      const delivery = await agents.sendTaskText(t, `Feedback for ${agent}`);
      assert.equal(delivery.resumed, true);
      await pause(100);
      assert.match(readFileSync(join(store.taskDir(t.id), 'input.txt'), 'utf8'), new RegExp(`Feedback for ${agent}`));
      await tmux.killSession(t.session);
    }
  } finally {
    for (const num of [2, 3, 4]) await tmux.killSession(`task-${num}`);
  }
});

test('review feedback resumes the task and marks comments sent after delivery', async () => {
  const t = task('claude', 7, 'fixture-review');
  const path = join(docs.outboxDir(t.id), 'result.md');
  mkdirSync(docs.outboxDir(t.id), { recursive: true }); writeFileSync(path, '# Result\n');
  const app = express(); app.use(express.json()); mountReview(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (route: string, body: object) => {
    const response = await fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  try {
    const item = (await post('/api/review/request', { task: t.id, path })).data;
    await post(`/api/review/${item.id}/comment`, { block: -1, text: 'Change the title.' });
    await tmux.newSession(t.session, root, { TASK_DIR: store.taskDir(t.id) }, ['sleep', '1000'], async () => {});
    await tmux.killSession(t.session);
    const result = await post(`/api/review/${item.id}/feedback`, {});
    assert.equal(result.status, 200);
    assert.equal(result.data.resumed, true);
    assert.equal(store.get(t.id)?.status, 'working');
    assert.match(readFileSync(join(store.taskDir(t.id), 'input.txt'), 'utf8'), /Review comments on result.md/);
    const saved = JSON.parse(readFileSync(join(root, 'state', 'reviews.json'), 'utf8'))[item.id];
    assert.equal(saved.state, 'changes');
    assert.equal(saved.comments[0].sent, true);
  } finally {
    await tmux.killSession(t.session);
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('Codex receives text while running and questions block terminal input', async () => {
  const t = task('codex', 8, 'fixture-running');
  await tmux.newSession(t.session, root, { TASK_DIR: store.taskDir(t.id) }, [join(bin, 'codex')], async () => {});
  try {
    for (let i = 0; i < 20 && !(await tmux.capture(t.session, 10)).includes('>'); i++) await pause(50);
    store.update(t.id, { status: 'working' });
    assert.equal((await agents.sendTaskText(t, 'Queued Codex message')).resumed, false);
    const input = join(store.taskDir(t.id), 'input.txt');
    for (let i = 0; i < 20 && !existsSync(input); i++) await pause(50);
    assert.match(readFileSync(input, 'utf8'), /Queued Codex message/);
    store.update(t.id, { status: 'needs-you', ask: 'Approve a tool call' });
    await assert.rejects(agents.sendTaskText(t, 'Do not type this'), /asks a question/);
    assert.doesNotMatch(readFileSync(input, 'utf8'), /Do not type this/);
  } finally { await tmux.killSession(t.session); }
});

test('a trust question blocks text sent to a live session', async () => {
  const t = task('antigravity', 9, 'fixture-trust');
  await tmux.newSession(t.session, root, { TASK_DIR: store.taskDir(t.id), TEST_QUESTION: '1' }, [join(bin, 'agy')], async () => {});
  try {
    for (let i = 0; i < 20 && !(await tmux.capture(t.session, 10)).includes('Do you trust'); i++) await pause(50);
    await assert.rejects(agents.sendTaskText(t, 'Do not type this'), /asks a question/);
  } finally { await tmux.killSession(t.session); }
});

test('a limited account keeps the task stopped and its inbox notice pending', async () => {
  const t = task('claude', 5, 'fixture-limited');
  const account = accounts.defaultFor('claude');
  account.limited = { at: new Date().toISOString(), note: 'limit' };
  const source = task('claude', 6, 'fixture-source');
  mkdirSync(docs.outboxDir(source.id), { recursive: true });
  writeFileSync(join(docs.outboxDir(source.id), 'file.md'), 'Content');
  docs.send(source.id, 'file.md', t.id);
  try {
    await assert.rejects(agents.sendTaskText(t, docs.pendingInboxNotice(t.id)!.notice), /stopped at a usage limit at .* \(limit\)\. .*Or move the task to another account\./);
    assert.equal(t.status, 'stopped');
    assert.deepEqual(docs.pendingInboxNotice(t.id)?.names, ['file.md']);
  } finally { delete account.limited; }
});

test.after(() => {
  try { execFileSync('tmux', ['-L', process.env.TASKBOARD_TMUX_SOCKET!, 'kill-server'], { stdio: 'ignore' }); } catch { /* gone */ }
  rmSync(root, { recursive: true, force: true });
});
