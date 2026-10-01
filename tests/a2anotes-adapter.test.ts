// The Taskboard adapter talks to a real A2A Notes service over MCP. The service comes from the a2a-notes dependency
// (github.com/Mgczacki/a2a-notes). Slack is the package's fake Slack Web API. Mario uses Taskboard. Alex uses only the
// A2A Notes MCP tools, as a person without Taskboard would.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = mkdtempSync(join(tmpdir(), 'tb-a2anotes-'));
process.env.TASKBOARD_DIR = join(root, 'server'); process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_A2A_PORT = String(4700 + Math.floor(Math.random() * 200));
const { startFakeSlack } = await import('a2a-notes/fake-slack');
const { startService } = await import('a2a-notes');
const savePrivate = (file: string, data: unknown) => writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
const { mountA2ANotes } = await import('../server/a2anotes/routes.ts');
const { TOKEN, URL_BASE, TB_DIR } = await import('../server/config.ts');
const { controllerMailToken } = await import('../server/mail/auth.ts');
const tasks = await import('../server/store.ts');

const fake = await startFakeSlack({ team: 'TEXAMPLE', users: [{ id: 'UMARIO01', name: 'Mario G' }, { id: 'UALEX01', name: 'Alex B' }] });
async function person(user: string) {
  const dir = mkdtempSync(join(tmpdir(), `a2an-${user}-`));
  savePrivate(join(dir, 'config.json'), { port: 0, scanIntervalSeconds: 0, slack: { clientId: 'fake', teamId: fake.team, redirectUri: 'http://localhost:4460/slack/callback', apiBase: `${fake.url}/api` } });
  savePrivate(join(dir, 'slack-credentials.json'), fake.credentials(user));
  const running = await startService(dir);
  return { running, url: `${running.server.url}/mcp`, address: `slack:${fake.team}:${user}` };
}
const mario = await person('UMARIO01'), alex = await person('UALEX01');
const settings = { enabled: true, url: mario.url, tokens: { person: mario.running.clients.add('taskboard-person', 'person'), reviewer: mario.running.clients.add('taskboard-reviewer', 'reviewer'), agent: mario.running.clients.add('taskboard-agent', 'agent') } };
mkdirSync(TB_DIR, { recursive: true });
writeFileSync(join(TB_DIR, 'a2anotes.json'), JSON.stringify(settings), { mode: 0o600 });

tasks.create({ id: 'worker', num: 7, title: 'Stage hosting', agent: 'claude', status: 'idle', cwd: root, folder: root, session: 'test', desc: '' } as any);
tasks.create({ id: 'controller', num: 0, title: 'Controller', agent: 'claude', status: 'idle', cwd: root, folder: root, session: 'test', desc: '' } as any);
const delivered: string[] = [];
const app = express(); app.use(express.json());
const adapter = mountA2ANotes(app, { background: false, delivery: { deliver: async (task, name) => { delivered.push(`${task}/${name}`); return { task, name, queued: '', deliveredAt: new Date().toISOString() } as any; } } });
const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/a2anotes`;
after(async () => { server.close(); await adapter.close(); await mario.running.close(); await alex.running.close(); await fake.close(); });

type Actor = 'user' | 'controller' | 'task' | 'stranger';
async function call(actor: Actor, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (actor === 'user') headers.origin = URL_BASE;
  else if (actor !== 'stranger') { headers['x-taskboard-token'] = TOKEN; headers['x-tb-actor'] = actor === 'task' ? 'worker' : 'controller'; }
  if (actor === 'controller') headers['x-tb-mail-controller'] = controllerMailToken;
  const res = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}
async function mcp(url: string, token: string) {
  const client = new Client({ name: 'alex-agent', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return async (name: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name, arguments: args })) as any).structuredContent;
}
const alexAgent = await mcp(alex.url, alex.running.clients.add('alex-cli', 'agent'));
const alexPerson = await mcp(alex.url, alex.running.clients.add('alex-page', 'person'));
const alexReviewer = await mcp(alex.url, alex.running.clients.add('alex-review', 'reviewer'));
const inbox = (task: string) => { try { return readdirSync(join(process.env.TASKBOARD_VAULT!, 'tasks', task, 'inbox')).filter(n => !n.startsWith('.')); } catch { return []; } };

test('callers get the MCP role of who they are, and strangers are refused', async () => {
  assert.equal((await call('stranger', '/status')).status, 403);
  const status = await call('task', '/status');
  assert.equal(status.data.enabled, true);
  assert.equal(status.data.identity.address, mario.address);
  assert.equal(status.data.identity.role, 'agent');
  assert.equal((await call('controller', '/status')).data.identity.role, 'reviewer');
  assert.equal((await call('user', '/status')).data.identity.role, 'person');
  assert.equal((await call('task', '/trusted', { address: alex.address, trusted: true })).status, 403);
  assert.equal((await call('controller', '/trusted', { address: alex.address, trusted: true })).status, 403);
  assert.equal((await call('user', '/trusted', { address: alex.address, name: 'Alex B', trusted: true })).data.trusted, true);
});

test('a Taskboard task sends an agent request to a person who does not use Taskboard', async () => {
  const id = randomUUID(), subject = 'Please confirm the Stage hosting settings';
  const outbox = join(process.env.TASKBOARD_VAULT!, 'tasks', 'worker', 'outbox'); mkdirSync(outbox, { recursive: true });
  const request = { version: 'a2anotes.request/1', message_id: id, audience: 'both', subject, target: { host: 'files.example.test' }, facts: [],
    agent_request: { when: 'Before any hosting change.', ask: 'Confirm the exact setting names.', details: [], deadline: null }, unknowns: [] };
  writeFileSync(join(outbox, 'request.json'), `${JSON.stringify(request, null, 2)}\n`);
  assert.equal((await call('task', '/files', { path: '/etc/hosts', kind: 'support' })).status, 400, 'only files in the task outbox');
  const staged = await call('task', '/files', { path: 'request.json', kind: 'agent' });
  assert.equal(staged.data.message_id, id, JSON.stringify(staged.data));
  const draft = await call('task', '/drafts', { to: alex.address, subject, audience: 'both', agent_file_id: staged.data.file_id, instruction: 'Ask Alex to confirm the exact setting names.',
    body: 'Hi Alex, thanks for confirming the hosting request. Please have your agent confirm the exact setting names before we make the change.' });
  assert.equal(draft.status, 200, JSON.stringify(draft.data));
  assert.equal(draft.data.approver, 'reviewer');
  assert.ok(inbox('controller').some(n => n.startsWith(`a2anotes-${id}-notice`)), 'the controller is told');
  const notice = readFileSync(join(process.env.TASKBOARD_VAULT!, 'tasks', 'controller', 'inbox', inbox('controller').find(n => n.startsWith(`a2anotes-${id}`))!), 'utf8');
  assert.ok(!notice.includes('setting names'), 'the notice has server fields only');
  assert.equal((await call('task', `/messages/${id}/approve`, { hash: draft.data.hash })).status, 403);
  assert.equal((await call('controller', `/messages/${id}/approve`, { hash: draft.data.hash })).data.state, 'approved');
  assert.equal((await call('task', `/messages/${id}/send`, { hash: draft.data.hash })).status, 403);
  const sent = await call('controller', `/messages/${id}/send`, { hash: draft.data.hash });
  assert.equal(sent.data.state, 'sent', JSON.stringify(sent.data));

  await alexAgent('a2anotes_sync');
  const listed = (await alexAgent('a2anotes_list_messages', { direction: 'incoming' })).messages.find((m: any) => m.message_id === id);
  assert.equal(listed.subject, '(held for review)', "Alex's agent waits for Alex");
  const full = await alexPerson('a2anotes_get_message', { id: listed.id });
  assert.equal(full.agent_file.name, `a2anotes-request-${id}.json`);
  assert.equal((await alexReviewer('a2anotes_approve', { id: listed.id, expected_hash: full.hash, decision: 'approve' })).error.code, 'needs_person', 'Mario is not trusted by Alex');
  await alexPerson('a2anotes_approve', { id: listed.id, expected_hash: full.hash, decision: 'approve' });
  const released = await alexAgent('a2anotes_get_message', { id: listed.id });
  assert.equal(released.agent_file.data.agent_request.ask, 'Confirm the exact setting names.');
});

test('a person without Taskboard sends to Taskboard, and the controller gives the approved request to a task', async () => {
  const id = randomUUID(), subject = 'Setting names for Stage';
  const file = `${JSON.stringify({ version: 'a2anotes.request/1', message_id: id, audience: 'agent', subject, target: null, facts: [{ statement: 'The names are CDN_STAGE and CDN_PROD.', source: 'Alex', status: 'confirmed' }],
    agent_request: { when: null, ask: 'Use these names for the Stage change.', details: [], deadline: null }, unknowns: [] }, null, 2)}\n`;
  const staged = await alexAgent('a2anotes_stage_file', { kind: 'agent', text: file, sha256: createHash('sha256').update(file).digest('hex'), request_id: `r-${randomUUID()}` });
  const draft = await alexAgent('a2anotes_create_draft', { to_address: mario.address, subject, audience: 'agent', agent_file_id: staged.file_id, request_id: `r-${randomUUID()}`,
    body: 'Hi Mario, my agent sent the Stage setting names in the attached agent file. No action is needed from you.' });
  assert.equal(draft.state, 'draft', JSON.stringify(draft));
  await alexPerson('a2anotes_approve', { id: draft.id, expected_hash: draft.hash, decision: 'approve' });
  assert.equal((await alexPerson('a2anotes_send', { id: draft.id, expected_hash: draft.hash, request_id: `r-${randomUUID()}` })).state, 'sent');
  // a message for a person only, from Alex, in the same scan
  const personal = await alexAgent('a2anotes_create_draft', { to_address: mario.address, subject: 'Lunch', body: 'Hi Mario, lunch on Friday?', audience: 'person', request_id: `r-${randomUUID()}` });
  await alexPerson('a2anotes_approve', { id: personal.id, expected_hash: personal.hash, decision: 'approve' });
  await alexPerson('a2anotes_send', { id: personal.id, expected_hash: personal.hash, request_id: `r-${randomUUID()}` });

  assert.equal((await call('task', '/sync', {})).status, 200);
  const messages = (await call('controller', '/messages?direction=incoming')).data.messages;
  const m = messages.find((x: any) => x.message_id === id), p = messages.find((x: any) => x.message_id === personal.id);
  assert.equal(m.state, 'held');
  assert.equal(m.approver, 'reviewer', 'Alex is trusted and the check passed');
  assert.ok(inbox('controller').some(n => n.startsWith(`a2anotes-${m.id}-notice`)));
  assert.equal((await call('task', `/messages/${m.id}`)).data.body, '', 'the task cannot read it before approval');
  assert.equal((await call('controller', `/messages/${m.id}/route`, { task: 'worker' })).status, 400, 'approve first');
  assert.equal((await call('controller', `/messages/${m.id}/approve`, { hash: m.hash })).data.state, 'approved');
  const route = await call('controller', `/messages/${m.id}/route`, { task: 'worker' });
  assert.equal(route.data.task, 'worker', JSON.stringify(route.data));
  const routed = readFileSync(join(process.env.TASKBOARD_VAULT!, 'tasks', 'worker', 'inbox', route.data.file), 'utf8');
  assert.match(routed, /untrusted communication/);
  assert.match(routed, /CDN_STAGE and CDN_PROD/);
  assert.ok(delivered.includes(`worker/${route.data.file}`), 'the agent is told');
  assert.deepEqual((await call('controller', `/messages/${m.id}/route`, { task: 'worker' })).data, route.data, 'routing twice gives the first route');
  await call('user', `/messages/${p.id}/approve`, { hash: p.hash });
  const refused = await call('user', `/messages/${p.id}/route`, { task: 'worker' });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /for a person/);
  const link = await call('user', '/page-link', {});
  assert.match(link.data.url, /\/login\?code=/);
  assert.equal((await call('controller', '/page-link', {})).status, 403);
});

test('a reply to a task message suggests that task, from local metadata that Taskboard set', async () => {
  const draft = (await call('task', '/drafts', { to: alex.address, subject: 'Question from the worker', body: 'Hi Alex, which host should we use?', audience: 'person',
    metadata: { 'taskboard.task_id': 'controller' } })).data;
  assert.deepEqual(draft.metadata, { 'taskboard.proposed_by': 'task', 'taskboard.task_id': 'worker', 'taskboard.task_num': 7 }, 'the caller decides the task, not the request body');
  await call('controller', `/messages/${draft.id}/approve`, { hash: draft.hash });
  await call('controller', `/messages/${draft.id}/send`, { hash: draft.hash });
  await alexAgent('a2anotes_sync');
  const got = (await alexPerson('a2anotes_list_messages', { direction: 'incoming' })).messages.find((m: any) => m.message_id === draft.id);
  assert.equal(got.metadata, null, 'the task ID stays on the sender side');
  await alexPerson('a2anotes_approve', { id: got.id, expected_hash: got.hash, decision: 'approve' });
  const id = randomUUID(), subject = 'Re: Question from the worker';
  const file = `${JSON.stringify({ version: 'a2anotes.request/1', message_id: id, audience: 'agent', subject, target: null, facts: [], agent_request: { when: null, ask: 'Use host stage-data.', details: [], deadline: null }, unknowns: [] }, null, 2)}\n`;
  const staged = await alexAgent('a2anotes_stage_file', { kind: 'agent', text: file, sha256: createHash('sha256').update(file).digest('hex'), request_id: `r-${randomUUID()}` });
  const reply = await alexPerson('a2anotes_create_draft', { to_address: mario.address, subject, audience: 'agent', agent_file_id: staged.file_id, reply_to: draft.id,
    body: 'Hi Mario, my agent attached the host name.', request_id: `r-${randomUUID()}` });
  await alexPerson('a2anotes_approve', { id: reply.id, expected_hash: reply.hash, decision: 'approve' });
  await alexPerson('a2anotes_send', { id: reply.id, expected_hash: reply.hash, request_id: `r-${randomUUID()}` });
  await call('controller', '/sync', {});
  const m = (await call('user', '/messages?direction=incoming')).data.messages.find((x: any) => x.message_id === id);
  assert.equal(m.suggested_task.id, 'worker');
  assert.match(m.suggested_task.reason, /Question from the worker/);
  const notice = inbox('controller').find(n => n.startsWith(`a2anotes-${m.id}-notice`));
  assert.ok(notice && readFileSync(join(process.env.TASKBOARD_VAULT!, 'tasks', 'controller', 'inbox', notice), 'utf8').includes('replies to a message from task #7 (worker)'));
  assert.equal(m.state, 'held', 'a suggestion routes nothing');
});

test('Taskboard and a plain MCP client see the same message and approval state at once', async () => {
  // Taskboard keeps no copy of message state: each read calls the service, so an approval made by one client
  // shows in the other client on its next read, without events or a refresh step.
  const plain = await mcp(mario.url, mario.running.clients.add('mario-other-client', 'person'));
  const fields = (m: any) => ({ state: m.state, hash: m.hash, approver: m.approver, approved_by: m.approved_by, audience: m.audience, subject: m.subject, allowed_actions: m.allowed_actions });
  const send = async (subject: string) => {
    const d = await alexAgent('a2anotes_create_draft', { to_address: mario.address, subject, body: `Hi Mario, ${subject.toLowerCase()}.`, audience: 'person', request_id: `r-${randomUUID()}` });
    await alexPerson('a2anotes_approve', { id: d.id, expected_hash: d.hash, decision: 'approve' });
    await alexPerson('a2anotes_send', { id: d.id, expected_hash: d.hash, request_id: `r-${randomUUID()}` });
    await plain('a2anotes_sync');
    return (await plain('a2anotes_list_messages', { direction: 'incoming' })).messages.find((m: any) => m.message_id === d.id);
  };
  const first = await send('First state check');
  const same = async (id: string) => {
    const viaTaskboard = (await call('user', `/messages/${id}`)).data, viaClient = await plain('a2anotes_get_message', { id });
    assert.deepEqual(fields(viaTaskboard), fields(viaClient));
    const listed = (await call('user', '/messages?direction=incoming')).data.messages.find((m: any) => m.id === id);
    assert.deepEqual(fields(listed), fields((await plain('a2anotes_list_messages', { direction: 'incoming' })).messages.find((m: any) => m.id === id)));
    return viaTaskboard;
  };
  assert.equal((await same(first.id)).state, 'held');
  // approved in the other client: Taskboard shows it on its next read
  await plain('a2anotes_approve', { id: first.id, expected_hash: first.hash, decision: 'approve' });
  assert.equal((await same(first.id)).state, 'approved');
  // approved in Taskboard: the other client shows it on its next read
  const second = await send('Second state check');
  await call('user', `/messages/${second.id}/approve`, { hash: second.hash, decision: 'approve' });
  const after = await same(second.id);
  assert.equal(after.state, 'approved');
  assert.equal(after.approved_by, 'person');
});

test('when a2anotes.json is missing, the adapter reports off and changes nothing', async () => {
  const offRoot = mkdtempSync(join(tmpdir(), 'tb-a2anotes-off-'));
  const offApp = express(); offApp.use(express.json());
  const off = mountA2ANotes(offApp, { background: false, dir: offRoot });
  const offServer = offApp.listen(0, '127.0.0.1'); await new Promise<void>(r => offServer.once('listening', r));
  const url = `http://127.0.0.1:${(offServer.address() as { port: number }).port}/api/a2anotes`;
  const headers = { origin: URL_BASE, 'content-type': 'application/json' };
  const status = await (await fetch(`${url}/status`, { headers })).json();
  assert.equal(status.enabled, false);
  assert.equal(status.setup.installed, true, 'a2a-notes comes with Taskboard');
  assert.equal(status.setup.linked, false);
  assert.equal((await fetch(`${url}/messages`, { headers })).status, 404);

  // setup from the dashboard: config, a running service, tokens, and a2anotes.json, in a test folder and port
  const task = await fetch(`${url}/setup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-taskboard-token': TOKEN, 'x-tb-actor': 'worker' }, body: '{}' });
  assert.equal(task.status, 403, 'only the person starts the setup');
  const setup = await fetch(`${url}/setup`, { method: 'POST', headers, body: '{}' });
  const done = await setup.json();
  assert.equal(setup.status, 200, JSON.stringify(done));
  assert.deepEqual({ configured: done.setup.configured, running: done.setup.running, linked: done.setup.linked, version: done.setup.serviceVersion },
    { configured: true, running: true, linked: true, version: done.setup.version });
  assert.equal(done.setup.folder, join(TB_DIR, 'a2a-notes'), 'a test server never uses the real ~/.a2a-notes');
  const settingsText = readFileSync(join(offRoot, 'a2anotes.json'), 'utf8');
  assert.equal(statSync(join(offRoot, 'a2anotes.json')).mode & 0o777, 0o600);
  const after = await (await fetch(`${url}/status`, { headers })).json();
  assert.equal(after.enabled, true);
  assert.equal(after.connection.signed_in, false);
  assert.equal(after.identity.role, 'person');
  // a second setup finds everything done and keeps the tokens
  assert.equal((await fetch(`${url}/setup`, { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal(readFileSync(join(offRoot, 'a2anotes.json'), 'utf8'), settingsText);
  // Connect Slack: a Slack sign-in link that returns to the Taskboard Inbox
  const link = (await (await fetch(`${url}/slack-sign-in`, { method: 'POST', headers, body: '{}' })).json()).url;
  assert.match(link, /^https:\/\/slack\.com\/oauth\/v2\/authorize\?/);
  assert.equal(new URL(link).searchParams.get('team'), 'T08LG8BQH1P');
  offServer.close(); await off.close();
  // stop the test service through its own command
  execFileSync(process.execPath, [join(process.cwd(), 'node_modules', 'a2a-notes', 'bin', 'a2a-notes.js'), 'stop', '--dir', join(TB_DIR, 'a2a-notes')]);
});
