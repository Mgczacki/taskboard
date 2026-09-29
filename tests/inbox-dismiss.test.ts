import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

test('dismiss retains review data without acceptance or feedback, and can be restored', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tb-dismiss-'));
  process.env.TASKBOARD_DIR = join(root, 'server');
  process.env.TASKBOARD_VAULT = join(root, 'vault');
  const { mountReview } = await import('../server/review.ts');
  const app = express(); app.use(express.json()); mountReview(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const call = async (path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/review${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  try {
    const folder = join(root, 'vault', 'tasks', 'example', 'outbox'); mkdirSync(folder, { recursive: true });
    const path = join(folder, 'note.md'); writeFileSync(path, '# Please review\n');
    const created = (await call('/request', { path })).data;
    await call(`/${created.id}/comment`, { block: -1, text: 'Unsent comment' });
    const before = (await call('')).data[0];
    const dismissed = (await call(`/${created.id}/dismiss`, {})).data;
    assert.equal(dismissed.state, 'pending');
    assert.deepEqual(dismissed.comments, before.comments);
    assert.deepEqual(dismissed.versions, before.versions);
    assert.ok(dismissed.dismissedAt);
    assert.equal((await call('')).data.length, 0);
    assert.equal((await call('?dismissed=1')).data.length, 1);
    assert.equal((await call(`/${created.id}/accept`, {})).status, 409);
    assert.equal((await call(`/${created.id}/feedback`, {})).status, 409);
    const saved = JSON.parse(readFileSync(join(root, 'server', 'reviews.json'), 'utf8'))[created.id];
    assert.ok(saved.dismissedAt);
    assert.equal(saved.comments[0].sent, undefined);
    assert.equal((await call(`/${created.id}/dismiss`, {})).data.dismissedAt, saved.dismissedAt);
    await call(`/${created.id}/restore`, {});
    assert.equal((await call('')).data[0].state, 'pending');
    await call(`/${created.id}/dismiss`, {});
    const next = (await call('/request', { path })).data;
    assert.equal(next.version, 2);
    assert.equal(next.dismissedAt, undefined);
    assert.equal((await call('')).data.length, 1);
    await call(`/${created.id}/accept`, {});
    await call(`/${created.id}/dismiss`, {});
    assert.equal((await call(`/${created.id}/restore`, {})).data.state, 'accepted');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
