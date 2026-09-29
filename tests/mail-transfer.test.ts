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
  const body = 'A long message. '.repeat(3000);
  const file = { ...stageBytes(Buffer.from(body), 'message.txt'), longBody: true, review: { verdict: 'communication' as const, reason: 'Reviewed', at: new Date().toISOString() } };
  const draft = sender.add({ direction: 'outbox', source: 'user', from: 'U1', to: 'U2', subject: 'Long text', body, files: [file] });
  sender.update(draft.id, m => { m.review = { verdict: 'communication', reason: 'Reviewed', at: new Date().toISOString() }; });
  sender.approve(draft.id, 'user', draft.hash, 'user');
  let text = '', blocks = '';
  const sendSlack = { identity: () => ({ user: 'U1', team: 'T1' }), upload: async () => 'F123', call: async (method: string, args: Record<string, string>) => {
    if (method === 'users.info') return { user: { id: 'U2', team_id: 'T1' } };
    if (method === 'conversations.open') return { channel: { id: 'D1' } };
    if (method === 'chat.postMessage') { text = args.text; blocks = args.blocks; return { ts: '1' }; }
    return {};
  } } as unknown as SlackClient;
  await new MailService(sender, sendSlack).send(draft.id);
  assert.ok(text.includes(FILE_PREFIX));
  assert.ok(text.length < 40000);
  assert.equal(JSON.parse(blocks)[0].text.text, 'Long text');
  assert.match(JSON.parse(blocks)[1].elements[0].text, /Sent automatically by Taskboard/);
  assert.match(JSON.parse(blocks)[4].text.text, /Read the full text in message.txt sent above/);
  assert.equal(JSON.parse(blocks)[4].expand, false);
  assert.ok(!blocks.includes(body));
  assert.match(JSON.parse(blocks)[6].elements[1].text, /Get Taskboard/);
  assert.match(JSON.parse(blocks)[6].elements[1].text, /github.com\/Mgczacki\/taskboard\/blob\/master\/SETUP.md/);

  const recipient = new MailStore(join(root, 'recipient.json'));
  const receiveSlack = { identity: () => ({ user: 'U2', team: 'T1' }), call: async (method: string) => method === 'conversations.list' ? { channels: [{ id: 'D1', user: 'U1' }] } : { messages: [{ ts: '1', user: 'U1', text: text.replace(/\n/g, ' ') }] }, download: async () => verifyFile(file) } as unknown as SlackClient;
  await new MailService(recipient, receiveSlack).sync();
  assert.equal(recipient.read().messages[0].body, body);
  assert.equal(recipient.read().messages[0].files?.[0].hash, file.hash);
  assert.equal(recipient.read().messages[0].files?.[0].review, undefined);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
