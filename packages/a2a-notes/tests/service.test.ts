import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { encode, escapeMarkup, sha256, writeAgentFile, agentFileName } from '../src/protocol.ts';
import { ServiceError } from '../src/store.ts';
import { ADAM, EVE, MARIO, agent, agentRequest, fakeWorkspace, person, personService, reviewer, rid, stageAgentFile } from './helpers.ts';

const fake = await fakeWorkspace();
after(() => fake.close());
const code = async (p: Promise<unknown> | (() => unknown), expected: string) => {
  try { await (typeof p === 'function' ? p() : p); } catch (e) { assert.equal((e as ServiceError).code, expected, (e as Error).message); return; }
  assert.fail(`expected ${expected}`);
};

test('a person message goes from Mario to Adam, and the approval rules apply on both sides', async () => {
  const mario = personService(fake, MARIO), adam = personService(fake, ADAM);
  const draft = await mario.service.createDraft(agent, { to_address: adam.address, subject: 'Report ready', body: 'Hi Adam, the report is ready. Please read it by Friday.', audience: 'person', request_id: rid() });
  assert.equal(draft.state, 'draft');
  assert.equal(draft.approver, 'person', 'Adam is not a trusted sender yet');
  await code(() => mario.service.approve(agent, { id: draft.id, expected_hash: draft.hash, decision: 'approve' }), 'forbidden');
  await code(() => mario.service.approve(reviewer, { id: draft.id, expected_hash: draft.hash, decision: 'approve' }), 'needs_person');
  mario.service.setTrusted(person, { address: adam.address, name: 'Adam B', trusted: true });
  await code(() => mario.service.approve(reviewer, { id: draft.id, expected_hash: 'x', decision: 'approve' }), 'hash_changed');
  const approved = mario.service.approve(reviewer, { id: draft.id, expected_hash: draft.hash, decision: 'approve' });
  assert.equal(approved.approval?.by, 'reviewer');
  await code(mario.service.send(agent, { id: draft.id, expected_hash: draft.hash, request_id: rid() }), 'forbidden');
  const sent = await mario.service.send(reviewer, { id: draft.id, expected_hash: draft.hash, request_id: rid() });
  assert.equal(sent.state, 'sent');

  await adam.service.scanNow();
  const inbox = adam.service.list(person, { direction: 'incoming' }).messages;
  assert.equal(inbox.length, 1);
  const held = inbox[0];
  assert.equal(held.state, 'held');
  assert.equal(held.from, mario.address);
  assert.equal(adam.service.get(agent, held.id).body, '', 'an agent cannot read a held message');
  assert.equal(adam.service.get(agent, held.id).subject, '(held for review)');
  await code(() => adam.service.approve(reviewer, { id: held.id, expected_hash: adam.service.get(person, held.id).hash, decision: 'approve' }), 'needs_person');
  adam.service.approve(person, { id: held.id, expected_hash: adam.service.get(person, held.id).hash, decision: 'approve' });
  assert.equal(adam.service.get(agent, held.id).body, '', 'a person message never goes to an agent');
  assert.equal(adam.service.get(person, held.id).body, 'Hi Adam, the report is ready. Please read it by Friday.');
  // a second scan and a Slack page read twice do not duplicate the message
  adam.service.store.change(d => { d.cursors = {}; });
  await adam.service.scanNow();
  assert.equal(adam.service.list(person, { direction: 'incoming' }).messages.length, 1);
});

test('a both message carries a verified agent file, and the agent gets the file only after approval', async () => {
  const mario = personService(fake, MARIO), adam = personService(fake, ADAM);
  const id = randomUUID(), subject = 'Please confirm the Stage hosting settings';
  const staged = stageAgentFile(mario.service, agent, agentRequest(id, subject));
  assert.equal(staged.name, agentFileName(id));
  const first = await mario.service.createDraft(agent, { to_address: adam.address, subject, audience: 'both', agent_file_id: staged.file_id, request_id: rid(),
    body: 'Hi Adam, please confirm the exact release keys for stage-data.sekai.chat before the hosting change.', instruction: 'Ask Adam to confirm the exact setting names.' });
  assert.equal(first.id, id, 'the draft uses the agent file message_id');
  assert.ok(first.body_check!.flags.some(f => f.code === 'agent_detail'));
  assert.ok(first.body_check!.flags.some(f => f.code === 'ask_changed'));
  mario.service.setTrusted(person, { address: adam.address, trusted: true });
  assert.equal(first.approver, 'person', 'a flagged body needs the person');
  const revised = await mario.service.reviseDraft(agent, { id, expected_hash: first.hash, subject, audience: 'both', agent_file_id: staged.file_id,
    body: 'Hi Adam, thanks for confirming the hosting request for stage-data.sekai.chat. Please have your agent confirm the exact setting names for that hosting change before we make it.' });
  assert.notEqual(revised.hash, first.hash);
  assert.equal(revised.body_flags, 0);
  assert.equal(revised.approver, 'reviewer');
  mario.service.approve(reviewer, { id, expected_hash: revised.hash, decision: 'approve' });
  await mario.service.send(reviewer, { id, expected_hash: revised.hash, request_id: rid() });
  const posted = [...fake.channels.values()].flatMap(c => c.messages).find(m => m.text.includes(`ID: ${id}`))!;
  assert.match(posted.text, /^A2ANotes\/1\n/);
  assert.match(posted.text, /\nTransport-File-Slack: [0-9a-f-]{36} \| F[0-9A-F]+\n/);
  assert.match(posted.text, /\nSent by Mario G with A2A Notes\.$/);

  await adam.service.scanNow();
  const note = adam.service.list(person, { direction: 'incoming' }).messages.find(m => m.message_id === id)!;
  assert.equal(note.state, 'held');
  const hidden = adam.service.get(agent, note.id);
  assert.equal(hidden.agent_file?.status, 'held');
  assert.equal((hidden.agent_file as any).data, undefined);
  adam.service.setTrusted(person, { address: mario.address, trusted: true });
  const view = adam.service.get(reviewer, note.id);
  assert.equal(view.approver, 'reviewer');
  assert.ok(view.body, 'the review agent can read a message that it may approve');
  adam.service.approve(reviewer, { id: note.id, expected_hash: view.hash, decision: 'approve' });
  const released = adam.service.get(agent, note.id);
  assert.equal(released.agent_file?.status, 'released');
  assert.equal((released.agent_file as any).data.agent_request.ask, 'Confirm the exact setting names.');
  // a level change ends the review agent's approval at the next release
  adam.service.setPolicy(person, { incoming: 1 });
  assert.equal(adam.service.get(agent, note.id).agent_file?.status, 'held');
  assert.equal(adam.service.get(agent, note.id).body, '');
});

test('an approval ends when the draft changes or the level changes before send', async () => {
  const mario = personService(fake, MARIO), adam = personService(fake, ADAM);
  mario.service.setTrusted(person, { address: adam.address, trusted: true });
  const d = await mario.service.createDraft(agent, { to_address: adam.address, subject: 'Hi', body: 'Hi Adam, the notes are ready.', audience: 'person', request_id: rid() });
  mario.service.approve(reviewer, { id: d.id, expected_hash: d.hash, decision: 'approve' });
  mario.service.setPolicy(person, { outgoing: 1 });
  await code(mario.service.send(reviewer, { id: d.id, expected_hash: d.hash, request_id: rid() }), 'approval_invalid');
  const r = await mario.service.reviseDraft(agent, { id: d.id, expected_hash: d.hash, subject: 'Hi', body: 'Hi Adam, the new notes are ready.', audience: 'person' });
  assert.equal(r.approval, null);
  assert.equal(r.state, 'draft');
  await code(mario.service.send(person, { id: d.id, expected_hash: r.hash, request_id: rid() }), 'not_approved');
  // retried create with the same request_id returns the same draft
  const request = rid();
  const a = await mario.service.createDraft(agent, { to_address: adam.address, subject: 'Once', body: 'Hi Adam, one draft only.', audience: 'person', request_id: request });
  const b = await mario.service.createDraft(agent, { to_address: adam.address, subject: 'Once', body: 'Hi Adam, one draft only.', audience: 'person', request_id: request });
  assert.equal(a.id, b.id);
});

test('an empty body, a missing agent file, a bot, and an untrusted agent action are refused', async () => {
  const mario = personService(fake, MARIO), adam = personService(fake, ADAM);
  await code(mario.service.createDraft(agent, { to_address: adam.address, subject: 'Hi', body: ' ', audience: 'person', request_id: rid() }), 'invalid_input');
  await code(mario.service.createDraft(agent, { to_address: adam.address, subject: 'Hi', body: 'Hello.', audience: 'agent', request_id: rid() }), 'agent_file_missing');
  await code(mario.service.createDraft(agent, { to_address: `slack:${fake.team}:UBOT01`, subject: 'Hi', body: 'Hello.', audience: 'person', request_id: rid() }), 'transport_error');
  await code(() => mario.service.setTrusted(agent, { address: adam.address, trusted: true }), 'forbidden');
  await code(() => mario.service.setPolicy(reviewer, { incoming: 3 }), 'forbidden');
  const other = stageAgentFile(mario.service, agent, agentRequest(randomUUID(), 'Other subject'));
  await code(mario.service.createDraft(agent, { to_address: adam.address, subject: 'Hi', body: 'Hello.', audience: 'both', agent_file_id: other.file_id, request_id: rid() }), 'agent_file_invalid');
  await code(() => mario.service.stageFile(agent, { kind: 'support', name: 'a.txt', text: 'abc', sha256: '0'.repeat(64), request_id: rid() }), 'hash_mismatch');
  await code(() => mario.service.stageFile(agent, { kind: 'support', name: 'a.txt', path: '/etc/hosts', sha256: '0'.repeat(64), request_id: rid() }), 'invalid_input');
});

test('version failures, bad counts, identity mismatches, and plain chat stay away from agents', async () => {
  const adam = personService(fake, ADAM), eve = personService(fake, EVE);
  const wire = (extra = {}) => ({ id: randomUUID(), from: eve.address, to: adam.address, subject: 'From Eve', audience: 'person' as const, replyTo: null, body: 'Hi Adam, a note from Eve.', files: [], transportFiles: {}, ...extra });
  const post = (text: string) => fake.inject(EVE, ADAM, escapeMarkup(text));
  const m1 = wire(); post(encode({ ...m1, threadId: m1.id }).replace(/^A2ANotes\/1/, 'A2ANotes/2'));
  const m2 = wire(); post(encode({ ...m2, threadId: m2.id }).replace(/Body-Bytes: \d+/, 'Body-Bytes: 3'));
  const m3 = wire({ from: `slack:${fake.team}:${MARIO}` }); post(encode({ ...m3, threadId: m3.id }));
  post('Hi Adam, lunch at noon?');
  // an agent file with an unknown version: send it through Eve's Slack account with a matching header
  const id = randomUUID();
  const bytes = Buffer.from(writeAgentFile(agentRequest(id, 'From Eve')).toString('utf8').replace('a2anotes.request/1', 'a2anotes.request/2'));
  const fileId = randomUUID();
  await eve.transport.send({ to: adam.address, messageId: id, files: [{ id: fileId, name: agentFileName(id), bytes }], blocks: () => [],
    text: map => escapeMarkup(encode({ ...wire({ audience: 'both', agentFile: { id: fileId, name: agentFileName(id), size: bytes.length, sha256: sha256(bytes) }, transportFiles: { Slack: map } }), id, threadId: id })) });

  await adam.service.scanNow();
  const all = adam.service.list(person, { direction: 'incoming' }).messages.filter(m => m.from === eve.address);
  const codes = all.map(m => m.failure_code).sort();
  assert.deepEqual(codes, ['body_bytes_mismatch', 'identity_mismatch', 'unsupported_version', 'unsupported_version']);
  assert.ok(all.every(m => m.state === 'failed' && m.approver === 'nobody'));
  const v2 = all.find(m => m.failure_code === 'unsupported_version' && !m.message_id.startsWith(id))!;
  const detail = adam.service.get(person, v2.id) as any;
  assert.match(detail.failure.reason, /A2ANotes\/2/);
  assert.match(detail.failure.raw, /^A2ANotes\/2\n/);
  assert.equal(adam.service.list(agent, { direction: 'incoming' }).messages.filter(m => m.from === eve.address).length, 0, 'agents never see failed text');
  await code(() => adam.service.get(agent, v2.id), 'not_found');
});

test('a lost Slack reply gives delivery_uncertain, and the retry finds the posted message instead of posting twice', async () => {
  const mario = personService(fake, MARIO), adam = personService(fake, ADAM);
  const d = await mario.service.createDraft(agent, { to_address: adam.address, subject: 'Once', body: 'Hi Adam, this goes once.', audience: 'person', request_id: rid() });
  mario.service.approve(person, { id: d.id, expected_hash: d.hash, decision: 'approve' });
  fake.fail('chat.postMessage', { mode: 'lost', count: 1 });
  await code(mario.service.send(person, { id: d.id, expected_hash: d.hash, request_id: rid() }), 'delivery_uncertain');
  assert.equal(mario.service.get(person, d.id).state, 'delivery_uncertain');
  const again = await mario.service.send(person, { id: d.id, expected_hash: d.hash, request_id: rid() });
  assert.equal(again.state, 'sent');
  const copies = [...fake.channels.values()].flatMap(c => c.messages).filter(m => m.text.includes(`ID: ${d.id}`));
  assert.equal(copies.length, 1);

  // a reply that never reached Slack: the retry checks, finds nothing, and sends once
  const e = await mario.service.createDraft(agent, { to_address: adam.address, subject: 'Twice', body: 'Hi Adam, this also goes once.', audience: 'person', request_id: rid() });
  mario.service.approve(person, { id: e.id, expected_hash: e.hash, decision: 'approve' });
  fake.fail('chat.postMessage', { mode: 'timeout', count: 1 });
  await code(mario.service.send(person, { id: e.id, expected_hash: e.hash, request_id: rid() }), 'delivery_uncertain');
  assert.equal((await mario.service.send(person, { id: e.id, expected_hash: e.hash, request_id: rid() })).state, 'sent');
  assert.equal([...fake.channels.values()].flatMap(c => c.messages).filter(m => m.text.includes(`ID: ${e.id}`)).length, 1);

  // Slack refuses the post: the draft stays approved and unsent
  const f = await mario.service.createDraft(agent, { to_address: adam.address, subject: 'Refused', body: 'Hi Adam, Slack refuses this one.', audience: 'person', request_id: rid() });
  mario.service.approve(person, { id: f.id, expected_hash: f.hash, decision: 'approve' });
  fake.fail('chat.postMessage', { mode: 'error', count: 1, error: 'msg_too_long' });
  await code(mario.service.send(person, { id: f.id, expected_hash: f.hash, request_id: rid() }), 'send_failed');
  assert.equal(mario.service.get(person, f.id).state, 'approved');
});

test('after a restart the service reads saved cursors, receives what arrived while it was stopped, and marks interrupted sends', async () => {
  const mario = personService(fake, MARIO);
  let adam = personService(fake, ADAM);
  await adam.service.scanNow();
  const before = adam.service.list(person, { direction: 'incoming' }).messages.length;
  adam.service.stop(); // Adam's service is stopped
  for (const text of ['one', 'two']) {
    const d = await mario.service.createDraft(agent, { to_address: adam.address, subject: `While stopped ${text}`, body: `Hi Adam, message ${text}.`, audience: 'person', request_id: rid() });
    mario.service.approve(person, { id: d.id, expected_hash: d.hash, decision: 'approve' });
    await mario.service.send(person, { id: d.id, expected_hash: d.hash, request_id: rid() });
  }
  // an interrupted send in Adam's store: the process stopped between "sending" and Slack's answer
  adam.service.store.change(data => { data.notes.push({ id: 'out-x', messageId: randomUUID(), direction: 'out', state: 'sending', from: adam.address, to: mario.address, subject: 'x', body: 'x', audience: 'person', threadId: randomUUID(), replyTo: null, fileIds: [], hash: 'h', created: new Date().toISOString(), updated: new Date().toISOString() }); });
  adam = personService(fake, ADAM, adam.dir); // restart with the same data folder
  assert.equal(adam.service.store.note('out-x')?.state, 'delivery_uncertain');
  await adam.service.scanNow();
  assert.equal(adam.service.list(person, { direction: 'incoming' }).messages.length, before + 2);
  await adam.service.scanNow();
  assert.equal(adam.service.list(person, { direction: 'incoming' }).messages.length, before + 2, 'the cursor prevents duplicates');
  const status = adam.service.connectionStatus();
  assert.ok(status.last_success_at);
  assert.equal(status.stale, false);
});

test('a rate limit delays the next scan and shows in the status', async () => {
  const adam = personService(fake, ADAM);
  fake.fail('conversations.list', { mode: 'ratelimit', count: 1, retryAfter: 30 });
  await assert.rejects(adam.service.scanNow(), /rate limit/);
  const status = adam.service.connectionStatus();
  assert.ok(status.rate_limited_until);
  assert.match(String(status.last_error), /rate limit/);
  await adam.service.scanNow(); // skipped while limited: no Slack call, no error
  assert.equal(adam.service.connectionStatus().last_error, status.last_error);
});

test('a reply keeps the thread, uses the Slack thread, and old Taskboard messages still arrive', async () => {
  const mario = personService(fake, MARIO), adam = personService(fake, ADAM);
  const d = await mario.service.createDraft(agent, { to_address: adam.address, subject: 'Thread start', body: 'Hi Adam, can we talk about the report?', audience: 'person', request_id: rid() });
  mario.service.approve(person, { id: d.id, expected_hash: d.hash, decision: 'approve' });
  await mario.service.send(person, { id: d.id, expected_hash: d.hash, request_id: rid() });
  await adam.service.scanNow();
  const got = adam.service.list(person, { direction: 'incoming' }).messages.find(m => m.message_id === d.id)!;
  adam.service.approve(person, { id: got.id, expected_hash: adam.service.get(person, got.id).hash, decision: 'approve' });
  const reply = await adam.service.createDraft(person, { to_address: mario.address, subject: 'Re: Thread start', body: 'Hi Mario, yes, Friday works.', audience: 'person', reply_to: d.id, request_id: rid() });
  assert.equal(reply.thread_id, d.id);
  assert.equal(reply.reply_to, d.id);
  adam.service.approve(person, { id: reply.id, expected_hash: reply.hash, decision: 'approve' });
  await adam.service.send(person, { id: reply.id, expected_hash: reply.hash, request_id: rid() });
  const channel = [...fake.channels.values()].find(c => c.replies.some(r => r.text.includes(`ID: ${reply.id}`)))!;
  assert.equal(channel.replies.find(r => r.text.includes(`ID: ${reply.id}`))!.thread_ts, mario.service.get(person, d.id).transport!.ts);
  await mario.service.scanNow();
  const back = mario.service.list(person, { direction: 'incoming' }).messages.find(m => m.message_id === reply.id)!;
  assert.equal(back.thread_id, d.id);

  fake.inject(ADAM, MARIO, 'Taskboard message: Old. Sent automatically by Taskboard from Adam. Open Taskboard Inbox to read.\n[Taskboard message v1]\n' + JSON.stringify({ id: 'old-1', subject: 'Old', body: 'Hi Mario, from the old format.' }));
  await mario.service.scanNow();
  const legacy = mario.service.list(person, { direction: 'incoming' }).messages.find(m => m.message_id === 'old-1')!;
  assert.equal(legacy.state, 'held');
  assert.equal(mario.service.get(person, legacy.id).body, 'Hi Mario, from the old format.');
});
