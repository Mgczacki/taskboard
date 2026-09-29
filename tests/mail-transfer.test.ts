import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'tb-mail-transfer-'));
process.env.TASKBOARD_DIR = join(root, 'server');
process.env.TASKBOARD_VAULT = join(root, 'vault');
const { stageBytes, verifyFile } = await import('../server/mail/files.ts');
const { MailStore } = await import('../server/mail/store.ts');
const { MailService, FILE_PREFIX } = await import('../server/mail/service.ts');
type SlackClient = import('../server/mail/slack.ts').SlackClient;

test('a long message crosses Slack as a file and returns as exact text', async () => {
  const sender = new MailStore(join(root, 'sender.json'));
  sender.change(d => { d.contacts.push({ user: 'U2', name: 'Recipient', channel: 'D1', oldest: '0', status: 'active' }); });
  const body = 'A long message. '.repeat(3000);
  const file = { ...stageBytes(Buffer.from(body), 'message.txt'), longBody: true, review: { verdict: 'communication' as const, reason: 'Reviewed', at: new Date().toISOString() } };
  const draft = sender.add({ direction: 'outbox', source: 'user', from: 'U1', to: 'U2', subject: 'Long text', body, files: [file] });
  sender.update(draft.id, m => { m.review = { verdict: 'communication', reason: 'Reviewed', at: new Date().toISOString() }; });
  sender.approve(draft.id, 'user', draft.hash);
  let text = '';
  const sendSlack = { identity: () => ({ user: 'U1', team: 'T1' }), upload: async () => 'F123', call: async (method: string, args: Record<string, string>) => { if (method === 'chat.postMessage') { text = args.text; return { ts: '1' }; } return {}; } } as unknown as SlackClient;
  await new MailService(sender, sendSlack).send(draft.id);
  assert.ok(text.startsWith(FILE_PREFIX));
  assert.ok(text.length < 40000);

  const recipient = new MailStore(join(root, 'recipient.json'));
  recipient.change(d => { d.contacts.push({ user: 'U1', name: 'Sender', channel: 'D1', oldest: '0', status: 'active' }); });
  const receiveSlack = { identity: () => ({ user: 'U2', team: 'T1' }), call: async (method: string) => method === 'conversations.list' ? { channels: [] } : { messages: [{ ts: '1', user: 'U1', text }] }, download: async () => verifyFile(file) } as unknown as SlackClient;
  await new MailService(recipient, receiveSlack).sync();
  assert.equal(recipient.read().messages[0].body, body);
  assert.equal(recipient.read().messages[0].files?.[0].hash, file.hash);
  assert.equal(recipient.read().messages[0].files?.[0].review, undefined);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
