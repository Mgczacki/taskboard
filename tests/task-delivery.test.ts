import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import { waitFor } from './helpers/wait-for.ts';

const root = mkdtempSync(join(tmpdir(), 'tb-delivery-'));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-delivery-${process.pid}`;
process.env.CODEX_HOME = join(root, 'codex');
mkdirSync(process.env.CODEX_HOME, { recursive: true });
const bin = join(root, 'bin'); mkdirSync(bin, { recursive: true });
const fake = readFileSync(join(import.meta.dirname, 'fixtures', 'fake-agent.cjs'), 'utf8');
for (const name of ['claude', 'codex', 'agy']) writeFileSync(join(bin, name), fake, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
mkdirSync(process.env.TASKBOARD_DIR, { recursive: true });
writeFileSync(join(process.env.TASKBOARD_DIR, 'accounts.json'), JSON.stringify([{ id: 'codex-fixture', agent: 'codex', name: 'Codex fixture', dir: process.env.CODEX_HOME, maxParallel: 8, created: new Date().toISOString() }]));
writeFileSync(join(process.env.TASKBOARD_DIR, 'machine.json'), JSON.stringify({ controller: { autostart: false }, permissions: { trustWorkspaces: false } }));
const store = await import('../server/store.ts');
const agents = await import('../server/agents.ts');
const messageQueue = await import('../server/message-queue.ts');
const tmux = await import('../server/tmux.ts');
const accounts = await import('../server/accounts.ts');
const docs = await import('../server/docs.ts');
const { mountReview } = await import('../server/review.ts');
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
    await waitFor(async () => {
      if (await tmux.hasSession('fixture-keepalive')) return true;
      await tmux.newSession('fixture-keepalive', root, {}, ['sleep', '600'], async () => {});
      return true;
    }, { description: 'the fixture tmux server to answer', timeoutMs: 60_000 });
    for (const [i, agent] of (['claude', 'codex', 'antigravity'] as const).entries()) {
      const t = task(agent, i + 2, `fixture-${agent}`);
      const delivery = await agents.sendTaskText(t, `Feedback for ${agent}`);
      assert.equal(delivery.resumed, true);
      const input = join(store.taskDir(t.id), 'input.txt');
      await waitFor(() => existsSync(input) && readFileSync(input, 'utf8').includes(`Feedback for ${agent}`), {
        description: `${agent} to receive its feedback`,
        state: async () => `expected Feedback for ${agent}; screen:\n${await tmux.capture(t.session, 30)}; task: ${JSON.stringify(store.get(t.id))}`,
      });
      await tmux.killSession(t.session);
    }
  } finally {
    for (const num of [2, 3, 4]) await tmux.killSession(`task-${num}`);
    await tmux.killSession('fixture-keepalive');
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
    await waitFor(async () => (await tmux.capture(t.session, 10)).includes('for shortcuts'), {
      description: 'the Codex input box', state: async () => `expected an empty input box; screen:\n${await tmux.capture(t.session, 30)}`,
    });
    store.update(t.id, { status: 'working' });
    assert.equal((await agents.sendTaskText(t, 'Queued Codex message')).resumed, false);
    const input = join(store.taskDir(t.id), 'input.txt');
    await waitFor(() => existsSync(input) && readFileSync(input, 'utf8').includes('Queued Codex message'), {
      description: 'the queued Codex input', state: async () => `expected Queued Codex message; screen:\n${await tmux.capture(t.session, 30)}`,
    });
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
    await waitFor(async () => (await tmux.capture(t.session, 10)).includes('Do you trust'), {
      description: 'the Antigravity trust question', state: async () => `expected Do you trust; screen:\n${await tmux.capture(t.session, 30)}`,
    });
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

test('a digest does not enter a stopped manager session on a limited account', async () => {
  const t = task('claude', 10, 'fixture-manager');
  const account = accounts.defaultFor('claude');
  await tmux.newSession(t.session, root, { TASK_DIR: store.taskDir(t.id) }, [join(bin, 'claude')], async () => {});
  try {
    await waitFor(async () => (await tmux.capture(t.session, 10)).includes('Fake agent'), { description: 'the manager input box' });
    account.limited = { at: new Date().toISOString(), note: 'weekly limit' };
    const result = await messageQueue.send(t, '[Taskboard event digest, worker update]', { from: 'taskboard', kind: 'message' });
    assert.equal(result.state, 'failed');
    assert.match(result.reason || '', /stopped at a usage limit.*weekly limit/);
    assert.equal(store.get(t.id)?.status, 'stopped');
    assert.equal(existsSync(join(store.taskDir(t.id), 'input.txt')), false);
    assert.ok(result.id);
    assert.equal(messageQueue.viaHook(t.id, result.id!)?.state, 'queued');
    assert.equal(messageQueue.takeForHook(t.id, 'Stop'), null);
    assert.equal(messageQueue.list(t.id).find(x => x.id === result.id)?.state, 'queued');
  } finally {
    delete account.limited;
    await tmux.killSession(t.session);
  }
});

test.after(() => {
  try { execFileSync('tmux', ['-L', process.env.TASKBOARD_TMUX_SOCKET!, 'kill-server'], { stdio: 'ignore' }); } catch { /* gone */ }
  rmSync(root, { recursive: true, force: true });
});
