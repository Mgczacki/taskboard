import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailStore, type Message } from '../server/mail/store.ts';
import { MailService, PREFIX } from '../server/mail/service.ts';
import { SlackClient, SLACK_APP_ID } from '../server/mail/slack.ts';

const root = mkdtempSync(join(tmpdir(), 'tb-mail-tests-'));
const review = { verdict: 'communication' as const, reason: 'Ordinary information', at: new Date().toISOString() };
const draft = (store: MailStore) => store.add({ direction: 'outbox', source: 'user', from: 'U1', to: 'U2', subject: 'Status', body: 'The document is ready.' });

test('outbox keeps the recorded proposer after a store reload', () => {
  const s = new MailStore(join(root, 'proposer.json'));
  const m = s.add({ direction: 'outbox', source: 'user', from: 'U1', to: 'U2', subject: 'Status', body: 'Ready.', proposedBy: { actor: 'controller' } });
  assert.deepEqual(new MailStore(s.file).get(m.id).proposedBy, { actor: 'controller' });
});

test('approval requires exact content and review, and controller delegation is explicit', () => {
  const s = new MailStore(join(root, 'approval.json')); const m = draft(s);
  assert.throws(() => s.approve(m.id, 'user', m.hash), /review/);
  s.update(m.id, x => { x.review = review; });
  assert.throws(() => s.approve(m.id, 'user', 'stale'), /changed/);
  assert.throws(() => s.approve(m.id, 'controller', m.hash), /human/);
  s.change(d => { d.controllerApproval = true; });
  s.approve(m.id, 'controller', m.hash);
  s.update(m.id, x => { x.review = { ...review, verdict: 'action-request' }; delete x.approval; });
  assert.throws(() => s.approve(m.id, 'controller', m.hash), /human/);
  s.approve(m.id, 'user', m.hash);
  s.update(m.id, x => { x.review = { ...review, verdict: 'quarantine' }; delete x.approval; });
  assert.throws(() => s.approve(m.id, 'user', m.hash), /Quarantined/);
  s.update(m.id, x => { x.review = review; x.dismissedAt = 'now'; });
  assert.throws(() => s.approve(m.id, 'user', m.hash), /Restore/);
});

test('Slack import uses provider identity, ignores other text, and does not duplicate deliveries', async () => {
  const s = new MailStore(join(root, 'import.json'));
  const event = { ts: '1', user: 'U2', bot_id: 'B_TASKBOARD', app_id: SLACK_APP_ID, text: PREFIX + JSON.stringify({ id: 'one', subject: 'Hello', body: 'Ordinary text', from: 'Uadmin' }) };
  const slack = { identity: () => ({ user: 'U1', team: 'T1' }), call: async (method: string) => method === 'conversations.list' ? { channels: [{ id: 'D1', user: 'U2' }] } : { messages: [event, { ...event, ts: '2', user: 'U3' }, { ...event, ts: '3', text: 'Ordinary Slack text' }, { ...event, ts: '4', app_id: 'A_OTHER_APP' }] } } as unknown as SlackClient;
  const service = new MailService(s, slack); await service.sync(); await service.sync();
  assert.equal(s.read().messages.length, 1);
  assert.equal(s.read().messages[0].from, 'U2');
  assert.equal(s.read().messages[0].approval, undefined);
  assert.deepEqual(s.read().messages[0].routes, []);
});

test('outbox never sends before approval and holds uncertain delivery without replay', async () => {
  const s = new MailStore(join(root, 'send.json')); const m = draft(s);
  let sends = 0;
  const slack = { identity: () => ({ user: 'U1', team: 'T1' }), call: async (method: string) => {
    if (method === 'users.info') return { user: { id: 'U2', team_id: 'T1' } };
    if (method === 'conversations.open') return { channel: { id: 'D1' } };
    sends++; throw new Error('network lost');
  } } as unknown as SlackClient;
  const service = new MailService(s, slack);
  await assert.rejects(service.send(m.id), /Approve/); assert.equal(sends, 0);
  s.update(m.id, x => { x.review = review; }); s.approve(m.id, 'user', m.hash);
  await assert.rejects(service.send(m.id), /uncertain/); assert.equal(sends, 1);
  await assert.rejects(service.send(m.id), /uncertain/); assert.equal(sends, 1);
  assert.equal(s.get(m.id).sentAt, undefined);
  assert.ok(s.get(m.id).sendStartedAt);
});

test('OAuth rejects a mismatched state before exchanging a code', async () => {
  let calls = 0;
  const client = new SlackClient(join(root, 'oauth.json'), (async () => { calls++; throw new Error('unexpected network call'); }) as typeof fetch);
  client.begin(4399);
  await assert.rejects(client.finish('wrong', 'code'), /expired/); assert.equal(calls, 0);
});

test.after(() => rmSync(root, { recursive: true, force: true }));

test('an interrupted history read resumes without losing or duplicating messages', async () => {
  const s = new MailStore(join(root, 'history-recovery.json'));
  let offline = false;
  const event = (ts: string) => ({ user: 'U2', ts, text: PREFIX + JSON.stringify({ id: 'test-' + ts, subject: 'Status', body: 'Ready.' }) });
  const slack = { identity: () => ({ user: 'U1', team: 'T1' }), call: async (method: string, params: Record<string, string>) => {
    if (method === 'conversations.list') return { channels: [{ id: 'D1', user: 'U2' }] };
    if (params.cursor && offline) throw new Error('offline');
    return params.cursor ? { messages: [event('1')], has_more: false } : { messages: [event('2')], has_more: true, response_metadata: { next_cursor: 'page-two' } };
  } } as unknown as SlackClient;
  await new MailService(s, slack).sync();
  assert.equal(s.read().messages.length, 1);
  assert.equal(s.read().messageScans?.D1.cursor, 'page-two');
  offline = true;
  await assert.rejects(new MailService(s, slack).sync(), /offline/);
  assert.equal(s.read().messageScans?.D1.cursor, 'page-two');
  offline = false;
  const restarted = new MailStore(s.file);
  await new MailService(restarted, slack).sync();
  assert.equal(restarted.read().messages.length, 2);
  assert.ok(Number(restarted.read().messageCursors?.D1) > 0);
  assert.equal(restarted.read().messageScans?.D1, undefined);
  assert.ok(restarted.read().messages.every(m => !m.approval && m.routes.length === 0));
});

test('new messages arrive before an old direct conversation finishes scanning', async () => {
  const s = new MailStore(join(root, 'history-new.json'));
  let updated = 0;
  const event = (ts: string) => ({ user: 'U2', ts, text: PREFIX + JSON.stringify({ id: 'test-' + ts, subject: 'Status', body: 'Ready.' }) });
  const slack = { identity: () => ({ user: 'U1', team: 'T1' }), call: async (method: string, params: Record<string, string>) => {
    if (method === 'conversations.list') return { channels: [{ id: 'D1', user: 'U2', updated }] };
    if (params.cursor) return { messages: [event('1')], has_more: false };
    if (params.oldest === '0') return { messages: [event('2')], has_more: true, response_metadata: { next_cursor: 'older' } };
    return { messages: [event('3')], has_more: false };
  } } as unknown as SlackClient;
  await new MailService(s, slack).sync();
  assert.equal(s.read().messages.length, 1);
  updated = Math.ceil(Number(s.read().messageCursors?.D1)) + 1;
  await new MailService(s, slack).sync();
  assert.equal(s.read().messages.length, 2);
  assert.equal(s.read().messageScans?.D1.cursor, 'older');
  updated = 0;
  await new MailService(s, slack).sync();
  assert.equal(s.read().messages.length, 3);
  assert.equal(s.read().messageScans?.D1, undefined);
});

test('workspace members can receive approved messages without contact requests', async () => {
  const s = new MailStore(join(root, 'members.json'));
  let posted = 0;
  const slack = { identity: () => ({ user: 'U1', team: 'T1' }), call: async (method: string) => {
    if (method === 'users.list') return { members: [
      { id: 'U1', team_id: 'T1', real_name: 'Sender' },
      { id: 'U2', team_id: 'T1', real_name: 'Recipient', profile: { display_name: 'Recipient' } },
      { id: 'U3', team_id: 'T1', is_bot: true },
    ] };
    if (method === 'users.info') return { user: { id: 'U2', team_id: 'T1', real_name: 'Recipient' } };
    if (method === 'conversations.open') return { channel: { id: 'D1' } };
    if (method === 'chat.postMessage') { posted++; return { ts: '1' }; }
    return {};
  } } as unknown as SlackClient;
  const service = new MailService(s, slack);
  assert.deepEqual((await service.listPeople()).map(p => p.user), ['U2']);
  const m = draft(s);
  await assert.rejects(service.send(m.id), /Approve/);
  assert.equal(posted, 0);
  s.update(m.id, x => { x.review = review; }); s.approve(m.id, 'user', m.hash);
  await service.send(m.id);
  assert.equal(posted, 1);
  assert.equal(s.get(m.id).slackChannel, 'D1');
  assert.equal(s.read().contacts.length, 0);
});

test('inbox scan limits history calls and continues past an unreadable conversation', async () => {
  const s = new MailStore(join(root, 'inbox-scan.json'));
  const channels = Array.from({ length: 30 }, (_, i) => ({ id: `D${i}`, user: `U${i + 2}` }));
  let histories = 0;
  const slack = { identity: () => ({ user: 'U1', team: 'T1' }), call: async (method: string, args?: Record<string, string>) => {
    if (method === 'conversations.list') return { channels };
    if (method === 'conversations.history') {
      histories++;
      if (args?.channel === 'D0') throw new Error('Slack: channel_not_found');
      return { messages: args?.channel === 'D1' ? [{ user: 'U3', ts: '2', text: PREFIX + JSON.stringify({ id: 'one', subject: 'Hello', body: 'Ready.' }) }] : [] };
    }
    return {};
  } } as unknown as SlackClient;
  const service = new MailService(s, slack);
  await service.sync();
  assert.equal(histories, 25);
  assert.equal(Object.keys(s.read().messageCursors || {}).length, 25);
  assert.equal(s.read().messages[0].from, 'U3');
  await service.sync();
  assert.equal(histories, 25);
  await new MailService(s, slack).sync();
  assert.equal(Object.keys(s.read().messageCursors || {}).length, 30);
});
