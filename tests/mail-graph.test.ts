import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MailStore } from '../server/mail/store.ts';
import { Avatars, allowedImageUrl } from '../server/mail/avatars.ts';
import type { SlackClient } from '../server/mail/slack.ts';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

test('Graph mail routes give the dashboard a short record of each message and nothing to agents', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mail-graph-'));
  process.env.TASKBOARD_DIR = join(root, 'server'); process.env.TASKBOARD_VAULT = join(root, 'vault');
  const { mountMail } = await import('../server/mail/routes.ts');
  const { TOKEN, URL_BASE } = await import('../server/config.ts');
  const store = new MailStore(join(root, 'server', 'mail.json'));
  const out = store.add({ direction: 'outbox', source: 'agent', from: 'U1', to: 'U2', subject: 'Question', body: 'x'.repeat(300), proposedBy: { actor: 'task', task: 't1', agent: 'claude' } });
  store.add({ direction: 'inbox', source: 'slack', from: 'U3', to: 'U1', subject: 'Reply', body: 'Private reply text' });
  store.add({ direction: 'inbox', source: 'agent', from: 't1', to: 'U1', subject: 'From a task', body: 'Not a person' });
  store.change(d => { d.contacts.push({ user: 'U2', name: 'Ana', channel: 'D2', oldest: '0' }); });
  const app = express(); app.use(express.json());
  const slack = { identity: () => null, call: async () => { throw new Error('no Slack in this test'); } } as unknown as SlackClient;
  const cleanup = mountMail(app, { background: false, slack, review: async () => ({ verdict: 'communication', reason: 'ok', at: new Date().toISOString() }) });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/mail`;
  const get = (path: string, headers: Record<string, string>) => fetch(base + path, { headers });
  const user = { origin: URL_BASE }, agent = { 'x-taskboard-token': TOKEN, 'x-tb-actor': 't1' };
  try {
    const graph = await (await get('/graph', user)).json();
    assert.deepEqual(graph.people.map((p: { user: string; name: string }) => [p.user, p.name]), [['U2', 'Ana'], ['U3', 'U3']]);
    assert.equal(graph.messages.length, 2);
    for (const m of graph.messages) { assert.equal(m.body, undefined); assert.equal(m.hash, undefined); }
    assert.equal(graph.messages[0].preview.length, 120);
    assert.equal(graph.messages[0].person, 'U2');
    assert.equal(graph.messages[1].person, 'U3');
    assert.equal((await (await get(`/${out.id}`, user)).json()).body, 'x'.repeat(300));
    for (const path of ['/graph', `/${out.id}`]) {
      const r = await get(path, agent);
      assert.equal(r.status, 400);
      assert.ok(!(await r.text()).includes('Private reply'));
      assert.equal((await get(path, {})).status, 403);
    }
    assert.equal((await get('/avatar/U2', agent)).status, 403);
    assert.equal((await get('/avatar/U2', { 'sec-fetch-site': 'same-origin', referer: URL_BASE + '/#graph' })).status, 404);
    assert.equal((await get('/people', user)).status, 400); // still its own route, not the message route
  } finally { cleanup(); server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('Avatars fetch a Slack picture once, without the token, and only from Slack or Gravatar hosts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'avatars-'));
  let infoCalls = 0, url = 'https://avatars.slack-edge.com/a.png';
  const slack = { identity: () => ({ user: 'U1' }), call: async (method: string, params: Record<string, string>) => {
    assert.equal(method, 'users.info'); infoCalls++;
    return { user: { id: params.user, profile: { display_name: 'Ana', image_72: url } } };
  } } as unknown as SlackClient;
  const requests: { url: string; headers: unknown }[] = [];
  let body: Buffer = PNG, type = 'image/png';
  const fetcher = (async (u: string, init: RequestInit) => {
    requests.push({ url: u, headers: init.headers });
    return new Response(body, { headers: { 'content-type': type } });
  }) as unknown as typeof fetch;
  try {
    assert.ok(allowedImageUrl('https://secure.gravatar.com/avatar/x'));
    assert.ok(!allowedImageUrl('http://avatars.slack-edge.com/a.png'));
    assert.ok(!allowedImageUrl('https://slack-edge.com.example.org/a.png'));
    const a = new Avatars(dir, slack, fetcher);
    assert.equal(await a.picture('../index'), undefined);
    const [p1, p2] = await Promise.all([a.picture('U2'), a.picture('U2')]);
    assert.equal(infoCalls, 1);
    assert.deepEqual(p1, p2);
    assert.equal(p1!.type, 'image/png');
    assert.deepEqual(readFileSync(p1!.path), PNG);
    assert.equal(statSync(p1!.path).mode & 0o777, 0o600);
    assert.equal(requests[0].headers, undefined);
    assert.equal(a.name('U2'), 'Ana');
    await a.picture('U2'); assert.equal(infoCalls, 1); // stored for a week

    url = 'https://evil.example.org/a.png';
    assert.equal(await a.picture('U3'), undefined);
    assert.equal(requests.length, 1);
    url = 'https://avatars.slack-edge.com/big.png'; body = Buffer.alloc(300 * 1024);
    assert.equal(await a.picture('U4'), undefined);
    assert.ok(!existsSync(join(dir, 'U4.img')));
    body = PNG; type = 'text/html';
    assert.equal(await a.picture('U5'), undefined);
    const before = infoCalls; await a.picture('U5'); assert.equal(infoCalls, before); // a failure waits an hour
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
