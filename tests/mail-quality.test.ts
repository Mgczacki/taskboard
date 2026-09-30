import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deterministicQuality, removeFlags } from '../server/mail/quality.ts';
import { draftBody } from '../server/mail/draft.ts';
import { approverFor } from '../server/mail/policy.ts';
import type { SlackClient } from '../server/mail/slack.ts';

const jason = `Hi Jason,

We found a gap while enabling game event tracking through Sekai MCP. Its publish guide tells an authoring agent to get the runtime bridge from our internal Flash repository. The MCP does not provide that bridge.

Could you make the current supported runtime bridge available through the MCP path? Please check the bridge version before publish.

For internal reference:
- MCP guide: https://github.com/sekai-app/sekai-mcp/blob/main/PUBLISH_GUIDE.md
- MCP publisher: https://github.com/sekai-app/sekai-mcp/blob/main/sekai_mcp/tools/publish.py
- Bridge source: https://github.com/sekai-app/sekai-flash-agent-python/tree/main/templates/vanilla/js/sekai/bridge

The next check is one MCP-built game with an event call on Android and a matching BigQuery row.`;

test('the Jason draft flags the sender check and keeps the request and links', () => {
  const result = deterministicQuality(jason);
  assert.equal(result.flags.length, 1);
  assert.match(result.flags[0].text, /^The next check/);
  assert.ok(!result.suggestedBody.includes('The next check'));
  assert.ok(result.suggestedBody.includes('Could you make the current supported runtime bridge available'));
  assert.ok(result.suggestedBody.includes('https://github.com/sekai-app/sekai-mcp/blob/main/PUBLISH_GUIDE.md'));
  assert.equal(removeFlags(jason, []), jason);
});

test('good requests and reader steps do not trigger the deterministic check', () => {
  for (const body of [
    'Could you check the MCP bridge version before publish?',
    'We can provide the bridge through MCP. Would your team use this resource?',
    'Does the Android host accept sekai.sendEvent?',
    'Your next step is to update the bridge before publish.',
  ]) assert.equal(deterministicQuality(body).flags.length, 0, body);
  assert.equal(deterministicQuality('My next step is to run tb mail list in /Users/alex/taskboard-wt/test.').flags.length, 1);
  assert.equal(deterministicQuality('Guide: https://github.com/sekai-app/sekai-mcp/blob/main/README.md').flags[0].reason, 'Internal link has no note about reader access');
  assert.equal(deterministicQuality('For internal reference:\nGuide: https://github.com/sekai-app/sekai-mcp/blob/main/README.md').flags.length, 0);
});

test('a sole request for confirmation, receipt, or user review asks the user instead', () => {
  for (const body of [
    'Hi Adam. Please confirm that you asked for this work.',
    'Hi Adam. Could you acknowledge receipt of this note?',
    'Hi Adam. Please confirm directly that you want Mario to review this scope. Mario can then select the targets.',
    'Hi Adam. Please ask Mario to review the scope.',
  ]) {
    const result = deterministicQuality(body);
    assert.equal(result.flags.length, 1, body);
    assert.equal(result.flags[0].reason, 'The user can decide this. Ask the user instead.');
    assert.equal(result.suggestedBody, '', body);
  }
});

test('a request for a needed action does not trigger the user decision check', () => {
  for (const body of [
    'Please send the exact release keys and conditional-write plan.',
    'Please confirm that you asked for this work and send the exact release keys.',
    'Could you check the bridge version before publish?',
    'Please review Mario\'s proposal and provide your findings.',
  ]) assert.equal(deterministicQuality(body).flags.length, 0, body);
});

test('the structured draft keeps the reader sections in order and free text still works', () => {
  const body = draftBody({ context: 'Your team owns the MCP bridge.', found: 'The guide uses an old version.', ask: 'Please update the bridge.', by: 'Friday', links: 'https://example.com/guide' });
  assert.ok(body.indexOf('Why you are getting this') < body.indexOf('What we found'));
  assert.ok(body.indexOf('What we found') < body.indexOf('What we need from you'));
  assert.ok(body.indexOf('What we need from you') < body.indexOf('By when'));
  assert.ok(body.indexOf('By when') < body.indexOf('Links'));
  assert.equal(draftBody({ body: 'Hello.' }), 'Hello.');
  assert.throws(() => draftBody({ context: 'Why', ask: 'Please check.', links: 'file:///tmp/secret' }), /HTTPS/);
});

test('quality flags keep the safety verdict and require user approval at level 2', () => {
  const root = mkdtempSync(join(tmpdir(), 'tb-mail-quality-'));
  process.env.TASKBOARD_DIR = join(root, 'server');
  process.env.TASKBOARD_VAULT = join(root, 'vault');
  process.env.TASKBOARD_TMUX_SOCKET = `tb-mail-quality-${process.pid}`;
  const run = async () => {
    const { mountMail } = await import('../server/mail/routes.ts');
    const { MailStore } = await import('../server/mail/store.ts');
    const { TOKEN, URL_BASE } = await import('../server/config.ts');
    const { controllerMailToken } = await import('../server/mail/auth.ts');
    const tasks = await import('../server/store.ts');
    tasks.create({ id: 'writer', num: 81, title: 'Writer', agent: 'codex', status: 'idle', cwd: root, folder: root, session: 'test', desc: '' });
    const store = new MailStore(join(root, 'server', 'mail.json'));
    store.change(data => { data.trustedSenders = [{ user: 'U2', name: 'Jason', at: new Date().toISOString() }]; });
    const posts: unknown[] = [];
    const slack = { identity: () => ({ user: 'U1', team: 'T1' }), call: async (method: string, args: unknown) => {
      if (method === 'users.info') return { user: { id: 'U2', team_id: 'T1' } };
      if (method === 'chat.postMessage') { posts.push(args); return { ts: '1' }; }
      if (method === 'conversations.open') return { channel: { id: 'D1' } };
      return {};
    } } as unknown as SlackClient;
    const app = express(); app.use(express.json());
    const cleanup = mountMail(app, { background: false, slack, levels: () => ({ incoming: 2, outgoing: 2, checkPrivateNotes: true }),
      review: async () => ({ verdict: 'communication', reason: 'Fixture', at: new Date().toISOString() }),
      qualityReview: async body => ({ ...deterministicQuality(body), state: 'done' }) });
    const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/mail`;
    const call = async (path: string, actor: 'task' | 'controller' | 'user', body?: unknown) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (actor === 'user') headers.origin = URL_BASE;
      else { headers['x-taskboard-token'] = TOKEN; headers['x-tb-actor'] = actor === 'task' ? 'writer' : 'controller'; }
      if (actor === 'controller') headers['x-tb-mail-controller'] = controllerMailToken;
      const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    };
    try {
      const draft = await call('/propose', 'task', { to: 'U2', subject: 'MCP bridge', body: jason });
      assert.equal(draft.status, 200);
      assert.equal(draft.data.quality.flags.length, 1);
      const id = draft.data.id;
      for (let i = 0; i < 100 && !store.get(id).review; i++) await new Promise(resolve => setTimeout(resolve, 10));
      let message = store.get(id);
      assert.equal(message.review?.verdict, 'communication');
      assert.equal(message.quality?.flags.length, 1);
      assert.equal(approverFor(message, store.read(), { incoming: 2, outgoing: 2, checkPrivateNotes: true }), 'user');
      assert.equal((await call(`/${id}/approve`, 'controller', { hash: message.hash })).status, 400);
      const edited = await call(`/${id}/revise`, 'task', { subject: message.subject, body: message.quality?.suggestedBody, hash: message.hash });
      assert.equal(edited.status, 200);
      for (let i = 0; i < 100 && !store.get(id).review; i++) await new Promise(resolve => setTimeout(resolve, 10));
      message = store.get(id);
      assert.equal(message.quality?.flags.length, 0);
      assert.equal(message.edits, undefined);
      assert.equal(message.review?.verdict, 'communication');
      assert.equal(approverFor(message, store.read(), { incoming: 2, outgoing: 2, checkPrivateNotes: true }), 'controller');
      const userDecision = await call('/propose', 'task', { to: 'U2', subject: 'Review request', body: 'Please confirm that you want Mario to review this work.' });
      assert.equal(userDecision.status, 200);
      assert.equal(userDecision.data.quality.flags[0].reason, 'The user can decide this. Ask the user instead.');
      for (let i = 0; i < 100 && !store.get(userDecision.data.id).review; i++) await new Promise(resolve => setTimeout(resolve, 10));
      const held = store.get(userDecision.data.id);
      assert.equal(held.review?.verdict, 'communication');
      assert.equal(approverFor(held, store.read(), { incoming: 2, outgoing: 2, checkPrivateNotes: true }), 'user');
      assert.equal(posts.length, 0);
    } finally { cleanup(); await new Promise<void>(resolve => server.close(() => resolve())); }
  };
  return run().finally(() => rmSync(root, { recursive: true, force: true }));
});
