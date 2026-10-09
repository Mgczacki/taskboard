// Message cards on the Waiting page (server/a2anotes/cards.ts): a task draft for a person shows as a card with its
// details, Approve and send sends it, Send back rejects it, a stuck draft shows a reminder, a check flag is explained,
// and a failed send says why and offers Send again. A2A Notes runs for real from the a2a-notes dependency, with the
// package's fake Slack Web API and temporary folders. Nothing goes to a real person or to Slack.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'tb-a2a-waiting-'));
process.env.TASKBOARD_DIR = join(root, 'server'); process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_A2A_CHECKS = 'rules';
const { startFakeSlack } = await import('a2a-notes/fake-slack');
const { startService } = await import('a2a-notes');
const { mountA2ANotes } = await import('../server/a2anotes/routes.ts');
const { TOKEN, URL_BASE, TB_DIR } = await import('../server/config.ts');
const tasks = await import('../server/store.ts');
const approvals = await import('../server/approvals.ts');
const { messageButtons, reminder, sortTime } = await import('../web/src/messageCard.ts');

// The body check command: it fails while the marker file exists, so a test can make the check "not finish".
const marker = join(root, 'fail-check');
const checker = join(root, 'check.mjs');
writeFileSync(checker, `import { existsSync } from 'node:fs';\nlet raw = ''; for await (const c of process.stdin) raw += c;\nif (existsSync(process.argv[2])) process.exit(1);\nprocess.stdout.write(JSON.stringify({ flags: [] }));\n`);

const fake = await startFakeSlack({ team: 'TEXAMPLE', users: [{ id: 'UMARIO01', name: 'Mario G' }, { id: 'UALEX01', name: 'Alex B' }] });
const dir = mkdtempSync(join(tmpdir(), 'a2an-mario-'));
writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 0, scanIntervalSeconds: 0, bodyCheckCommand: [process.execPath, checker, marker],
  slack: { clientId: 'fake', teamId: fake.team, redirectUri: 'http://localhost:4460/slack/callback', apiBase: `${fake.url}/api` } }), { mode: 0o600 });
writeFileSync(join(dir, 'slack-credentials.json'), JSON.stringify(fake.credentials('UMARIO01')), { mode: 0o600 });
const service = await startService(dir);
mkdirSync(TB_DIR, { recursive: true });
writeFileSync(join(TB_DIR, 'a2anotes.json'), JSON.stringify({ enabled: true, url: `${service.server.url}/mcp`,
  tokens: { person: service.clients.add('tb-person', 'person'), reviewer: service.clients.add('tb-reviewer', 'reviewer'), agent: service.clients.add('tb-agent', 'agent') } }), { mode: 0o600 });

tasks.create({ id: 'writer', num: 167, title: 'Design referrer tracking', agent: 'claude', status: 'idle', cwd: root, folder: root, session: 'test', desc: '' } as any);
tasks.create({ id: 'controller', num: 0, title: 'Controller', agent: 'claude', status: 'idle', cwd: root, folder: root, session: 'test', desc: '' } as any);
const app = express(); app.use(express.json());
const adapter = mountA2ANotes(app, { background: false, delivery: { deliver: async (task, name) => ({ task, name, queued: '', deliveredAt: new Date().toISOString() }) as any } });
const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/a2anotes`;
after(async () => { server.close(); await adapter.close(); await service.close(); await fake.close(); rmSync(root, { recursive: true, force: true }); });

const alex = `slack:${fake.team}:UALEX01`;
async function call(actor: 'user' | 'task', path: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (actor === 'user') headers.origin = URL_BASE; else { headers['x-taskboard-token'] = TOKEN; headers['x-tb-actor'] = 'writer'; }
  const res = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}
const card = async (id: string) => { await adapter.cards.sync(); return approvals.all().find(a => (a.payload as any)?.message === id && a.state === 'pending'); };
const inbox = () => { try { return readdirSync(join(process.env.TASKBOARD_VAULT!, 'tasks', 'writer', 'inbox')); } catch { return []; } };
const inboxText = (id: string, what: string) => { const n = inbox().find(x => x.startsWith(`a2anotes-${id}-${what}-`)); return n ? readFileSync(join(process.env.TASKBOARD_VAULT!, 'tasks', 'writer', 'inbox', n), 'utf8') : ''; };
const draft = async (subject: string, body: string, extra: Record<string, unknown> = {}) => {
  const r = await call('task', '/drafts', { to: alex, subject, body, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};

test('a task draft for a person shows as a Message card with who, what, the task, and Not sent yet', async () => {
  const d = await draft('Review request', 'Hi Alex, the referrer design is ready. Please review it by Friday.');
  assert.equal(d.approver, 'person', 'Alex is not a trusted recipient');
  const c = await card(d.id);
  assert.ok(c, 'the draft has a card');
  const p = c!.payload as any;
  assert.equal(c!.action, 'mail-out');
  assert.equal(p.stage, 'draft');
  assert.deepEqual(p.peer, { name: 'Alex B', address: alex });
  assert.equal(p.subject, 'Review request');
  assert.match(p.body, /Please review it by Friday/);
  assert.deepEqual(p.writer, { id: 'writer', num: 167, title: 'Design referrer tracking' });
  assert.equal(p.since, d.created, 'the card keeps the time of the message');
  assert.match(c!.detail, /State: not sent yet/);
  const listed = adapter.cards.list().find(m => m.message === d.id)!;
  assert.equal(listed.notSent, true);
  assert.equal(listed.stage, 'draft');
  assert.equal('body' in listed, false, 'tb pending list gets no message text');
  assert.equal(messageButtons(c! as any).approve, 'Approve and send');
  assert.equal(sortTime(c! as any), d.created);
});

test('Approve and send sends the exact version, and the task gets a notice and a log line', async () => {
  const d = await draft('Approve me', 'Hi Alex, the plan is ready. Please read it by Friday.');
  const c = await card(d.id);
  const done = await approvals.decide(c!.id, true);
  assert.equal(done!.state, 'approved', done!.result);
  assert.match(done!.result!, /^Approved and (sent|queued)/);
  let message = (await call('user', `/messages/${d.id}`)).data;
  for (let i = 0; i < 50 && message.state !== 'sent'; i++) {
    await new Promise(r => setTimeout(r, 100));
    message = (await call('user', `/messages/${d.id}`)).data;
  }
  assert.equal(message.state, 'sent'); await adapter.cards.sync();
  const notice = inboxText(d.id, 'sent') + inboxText(d.id, 'delivery');
  assert.match(notice, /Taskboard sent it|Slack confirmed delivery/);
  assert.match(tasks.readLog('writer'), /Taskboard sent it|Slack confirmed delivery/);
  assert.equal(await card(d.id), undefined, 'no second card for a sent draft');
});

test('a changed draft gets a new card, and the old card cannot approve the new text', async () => {
  const d = await draft('Changed', 'Hi Alex, the first version. Please read it by Friday.');
  const old = await card(d.id);
  const revised = await call('task', `/messages/${d.id}/revise`, { hash: d.hash, subject: 'Changed', body: 'Hi Alex, the second version. Please read it by Monday.' });
  assert.equal(revised.status, 200, JSON.stringify(revised.data));
  const now = await card(d.id);
  assert.notEqual(now!.id, old!.id);
  assert.equal(approvals.get(old!.id)!.state, 'expired');
  assert.match(approvals.get(old!.id)!.result!, /new version has its own card/);
  assert.equal((now!.payload as any).since, (old!.payload as any).since, 'the new card keeps the place of the old one');
  assert.equal((await approvals.decide(old!.id, true))!.state, 'expired', 'a closed card does nothing');
  assert.equal((await call('user', `/messages/${d.id}`)).data.state, 'draft');
});

test('Reject with a comment closes the draft and gives the comment to the task; Deny tells the task too', async () => {
  const d = await draft('Reject me', 'Hi Alex, the plan is ready. Please read it by Friday.');
  const c = await card(d.id);
  const back = await approvals.giveBack(c!.id, 'Ask for the date first.');
  assert.equal(back!.state, 'returned', back!.result);
  assert.match(back!.result!, /Rejected\. Your comment went to task #167/);
  assert.equal((await call('user', `/messages/${d.id}`)).data.state, 'rejected');
  assert.match(inboxText(d.id, 'comment'), /Ask for the date first\./);
  assert.match(tasks.readLog('writer'), /The user sent back the draft of this task to Alex B/);

  const e = await draft('Deny me', 'Hi Alex, another plan. Please read it by Friday.');
  const c2 = await card(e.id);
  assert.equal((await approvals.decide(c2!.id, false))!.state, 'denied');
  for (let i = 0; i < 50 && !inboxText(e.id, 'rejected'); i++) await new Promise(r => setTimeout(r, 20));
  assert.equal((await call('user', `/messages/${e.id}`)).data.state, 'rejected');
  assert.match(inboxText(e.id, 'rejected'), /The user rejected your draft to Alex B/);
});

test('a draft that nobody approves for 10 minutes shows a reminder', async () => {
  const d = await draft('Stuck', 'Hi Alex, the plan is ready. Please read it by Friday.');
  const c = await card(d.id);
  const created = Date.parse(d.created);
  assert.equal(adapter.cards.list(created + 9 * 60_000).find(m => m.message === d.id)!.reminder, false);
  const late = adapter.cards.list(created + 11 * 60_000).find(m => m.message === d.id)!;
  assert.equal(late.reminder, true);
  assert.equal(late.waitMin, 11);
  assert.equal(reminder(c! as any, created + 9 * 60_000), '');
  assert.equal(reminder(c! as any, created + 11 * 60_000), 'Nobody approved this draft in 11 minutes. It is not sent.');
  assert.equal(reminder({ ...c!, state: 'approved' } as any, created + 11 * 60_000), '', 'a decided card has no reminder');
});

test('check flags are explained: ask_changed offers Reject and ask to revise, check_failed offers Run the check again', async () => {
  const a = await draft('Ask changed', 'Hi Alex, please approve the two pull requests below by Friday.', { instruction: 'Ask Alex to review the referrer design.' });
  const ca = await card(a.id);
  const pa = ca!.payload as any;
  const ask = pa.notes.find((n: any) => n.code === 'ask_changed');
  assert.ok(ask, JSON.stringify(pa.notes));
  assert.match(ask.title, /asks for something different from the instruction/);
  assert.match(ask.text, /The instruction asks the reader to review/, 'the A2A Notes reason with the exact verb stays');
  assert.deepEqual(ask.actions, ['approve-anyway', 'send-back']);
  assert.equal(messageButtons(ca! as any).sendBack, true);

  writeFileSync(marker, '');
  const f = await draft('Check failed', 'Hi Alex, the plan is ready. Please read it by Friday.');
  const cf = await card(f.id);
  const pf = cf!.payload as any;
  assert.equal(pf.quality.state, 'failed');
  const failed = pf.notes.find((n: any) => n.code === 'check_failed');
  assert.match(failed.title, /did not finish/);
  assert.match(failed.todo, /Run the check again/);
  assert.match(pf.check.summary, /The message check did not finish/);
  const buttons = messageButtons(cf! as any);
  assert.equal(buttons.recheck, true);
  assert.equal(buttons.approve, 'Approve and send', 'the draft keeps an action');
  rmSync(marker);
  assert.equal((await call('task', `/messages/${f.id}/recheck`, { hash: f.hash })).status, 403, 'only the person runs the check again');
  const again = await call('user', `/messages/${f.id}/recheck`, { hash: f.hash });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.hash, f.hash, 'the same text keeps its hash');
  const after = await card(f.id);
  assert.notEqual(after!.id, cf!.id);
  assert.equal((after!.payload as any).quality.state, 'done');
  assert.equal((after!.payload as any).notes.length, 0);
});

test('a definite send failure is final and does not ask for the same approval', async () => {
  const d = await draft('Send fails', 'Hi Alex, the plan is ready. Please read it by Friday.');
  const c = await card(d.id);
  await new Promise(r => setTimeout(r, 1100));
  fake.fail('chat.postMessage', { mode: 'error', count: 1, error: 'channel_not_found' });
  const failed = await approvals.decide(c!.id, true);
  assert.equal(failed!.state, 'failed');
  assert.match(failed!.result!, /^Approved, but not sent\. Slack did not find the direct message channel with the recipient\. \(Slack error channel_not_found\.\)$/);
  assert.match(inboxText(d.id, 'not-sent'), /it was not sent\. Slack did not find the direct message channel/);
  assert.match(tasks.readLog('writer'), /but it was not sent/);
  assert.equal((await call('user', `/messages/${d.id}`)).data.state, 'permanent_failure');
  assert.equal(await card(d.id), undefined, 'a final failure has no repeated approval card');
  assert.ok(existsSync(join(process.env.TASKBOARD_VAULT!, 'tasks', 'writer', 'log.md')));
});

test('a draft that the controller may approve (approver reviewer) gets no card for the user', async () => {
  assert.equal((await call('user', '/trusted', { address: alex, name: 'Alex B', trusted: true })).status, 200);
  try {
    const d = await draft('Trusted', 'Hi Alex, the plan is ready. Please read it by Friday.');
    assert.equal(d.approver, 'reviewer', JSON.stringify(d));
    assert.equal(await card(d.id), undefined);
    assert.equal(adapter.cards.list().some(m => m.message === d.id), false);
  } finally { await call('user', '/trusted', { address: alex, trusted: false }); }
});
