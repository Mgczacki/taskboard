import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MailStore } from '../server/mail/store.ts';
import type { SlackClient } from '../server/mail/slack.ts';

test('sandbox mail search uses a fake Slack client and creates no delivery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tb-mail-search-'));
  process.env.TASKBOARD_DIR = join(root, 'server');
  process.env.TASKBOARD_VAULT = join(root, 'vault');
  process.env.TASKBOARD_TMUX_SOCKET = 'tb-mail-search-test';
  process.env.TASKBOARD_PORT = '4409';
  const { mountMail } = await import('../server/mail/routes.ts');
  const { MailService } = await import('../server/mail/service.ts');
  const { TOKEN, URL_BASE } = await import('../server/config.ts');
  const tasks = await import('../server/store.ts');
  tasks.create({ id: 'search-task', num: 64, title: 'Search', agent: 'codex', status: 'idle', cwd: root, folder: root, session: 'test', desc: '' });
  const store = new MailStore(join(root, 'server', 'mail.json'));
  const held = store.add({ direction: 'inbox', source: 'slack', from: 'U3', to: 'U1', subject: 'Hidden subject', body: 'private needle' });
  store.update(held.id, m => { m.review = { verdict: 'action-request', reason: 'Held for user approval', at: new Date().toISOString() }; });
  const sent = store.add({ direction: 'outbox', source: 'user', from: 'U1', to: 'U2', subject: 'Status', body: 'ready needle' });
  store.update(sent.id, m => { m.review = { verdict: 'communication', reason: 'Reviewed', at: new Date().toISOString() }; });
  const members = [
    { id: 'U1', team_id: 'T1', name: 'owner', real_name: 'Owner' },
    { id: 'U2', team_id: 'T1', name: 'adamb', real_name: 'Adam Bonk', profile: { display_name: 'Adam Bonk', title: 'Engineer', email: 'adam@example.com' } },
    { id: 'U3', team_id: 'T1', name: 'adamc', real_name: 'Adam Cole', profile: { display_name: 'Adam Cole', title: 'Designer' } },
    { id: 'U4', team_id: 'T1', name: 'bot', real_name: 'Adam Bot', is_bot: true },
    { id: 'U5', team_id: 'T1', name: 'old', real_name: 'Adam Old', deleted: true },
    ...Array.from({ length: 11 }, (_, i) => ({ id: `U${i + 10}`, team_id: 'T1', name: `alex${i}`, real_name: `Alex ${i}` })),
  ];
  let lists = 0; let lookups = 0; let sends = 0;
  const slack = { identity: () => ({ user: 'U1', team: 'T1', scopes: ['users:read', 'users:read.email'] }), call: async (method: string, params: Record<string, string>) => {
    if (method === 'users.list') { lists++; return { members }; }
    if (method === 'users.lookupByEmail') { lookups++; return { user: members[1] }; }
    if (method === 'users.info') return { user: members.find(m => m.id === params.user) };
    sends++; throw new Error('Unexpected Slack call');
  } } as unknown as SlackClient;
  const app = express(); app.use(express.json());
  const cleanup = mountMail(app, { background: false, slack, qualityReview: async body => ({ state: 'done', flags: [], suggestedBody: body, at: new Date().toISOString() }), review: async () => ({ verdict: 'communication', reason: 'Reviewed', at: new Date().toISOString() }) });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { 'x-taskboard-token': TOKEN, 'x-tb-actor': 'search-task', 'content-type': 'application/json' };
  const get = async (path: string) => { const res = await fetch(base + path, { headers }); return { status: res.status, body: await res.json() }; };
  const post = async (path: string, body: unknown) => { const res = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  try {
    assert.equal((await get('/api/mail/people?q=a')).status, 400);
    const people = await get('/api/mail/people?q=Adam');
    assert.equal(people.status, 200, JSON.stringify(people.body));
    assert.deepEqual(people.body.matches.map((m: { user: string }) => m.user), ['U2', 'U4', 'U3', 'U5']);
    assert.equal(people.body.matches[0].title, 'Engineer');
    assert.equal('email' in people.body.matches[0], false);
    assert.equal('handle' in people.body.matches[0], false);
    assert.equal((await get('/api/mail/people?q=Alex')).body.matches.length, 10);
    assert.equal((await get('/api/mail/people?q=Alex')).body.hasMore, true);
    assert.equal(lists, 1);
    assert.equal(readFileSync(join(root, 'server', 'mail-people-cache.json'), 'utf8').includes('Adam Bonk'), true);
    assert.equal((await new MailService(store, slack).searchPeople('Adam')).matches.length, 4);
    assert.equal(lists, 1);
    const email = await get('/api/mail/people?q=adam%40example.com');
    assert.equal(email.body.matches[0].email, 'adam@example.com');
    assert.equal(lookups, 1);
    const ambiguous = await post('/api/mail/propose', { to: 'Adam', subject: 'Status', body: 'Hello' });
    assert.equal(ambiguous.status, 400);
    assert.equal(ambiguous.body.matches.length, 4);
    assert.equal((await post('/api/mail/propose', { to: 'Adam Bot', subject: 'Status', body: 'Hello' })).status, 400);
    const draft = await post('/api/mail/propose', { to: 'Adam Bonk', subject: 'Status', body: 'Hello' });
    assert.equal(draft.status, 200);
    assert.equal(draft.body.recipient.name, 'Adam Bonk');
    assert.equal(store.get(draft.body.id).to, 'U2');
    assert.equal(store.get(draft.body.id).approval, undefined);
    assert.equal((await get('/api/mail/search?q=private')).body.matches.length, 0);
    assert.equal((await get('/api/mail/search?q=needle')).body.matches.length, 1);
    assert.equal((await get('/api/mail/search?q=needle')).body.matches[0].id, sent.id);
    const userSearch = await fetch(base + '/api/mail/search?q=private', { headers: { origin: URL_BASE } });
    assert.equal((await userSearch.json()).matches[0].id, held.id);
    assert.equal(store.read().peopleSearches?.length, 7);
    assert.equal(store.read().peopleSearches?.[0].task, 'search-task');
    const run = promisify(execFile);
    const cli = await run(process.execPath, ['bin/tb', 'mail', 'people', 'Adam Bonk'], { cwd: process.cwd(), env: { ...process.env, TB_URL: base, TB_TOKEN_FILE: join(root, 'server', 'token'), TASK_ID: 'search-task' } });
    assert.equal(JSON.parse(cli.stdout).matches[0].user, 'U2');
    const history = await run(process.execPath, ['bin/tb', 'mail', 'search', 'needle'], { cwd: process.cwd(), env: { ...process.env, TB_URL: base, TB_TOKEN_FILE: join(root, 'server', 'token'), TASK_ID: 'search-task' } });
    assert.equal(JSON.parse(history.stdout).matches[0].id, sent.id);
    const limited = { identity: () => ({ user: 'U1', team: 'T1', scopes: ['users:read'] }) } as unknown as SlackClient;
    await assert.rejects(new MailService(store, limited).searchPeople('adam@example.com'), /users:read.email/);
    assert.equal(sends, 0);
  } finally {
    cleanup(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true });
  }
});
