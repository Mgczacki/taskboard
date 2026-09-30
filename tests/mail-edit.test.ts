import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Level } from '../server/mail/policy.ts';
import type { Message, Verdict } from '../server/mail/store.ts';
import type { SlackClient } from '../server/mail/slack.ts';

test('the user edits an outgoing draft before it is sent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mail-edit-'));
  process.env.TASKBOARD_DIR = join(root, 'server'); process.env.TASKBOARD_VAULT = join(root, 'vault');
  const { mountMail, messageLevelsChanged } = await import('../server/mail/routes.ts');
  const { TOKEN, URL_BASE } = await import('../server/config.ts');
  const { controllerMailToken } = await import('../server/mail/auth.ts');
  const { MailStore } = await import('../server/mail/store.ts');
  const approvals = await import('../server/approvals.ts');
  const tasks = await import('../server/store.ts');
  tasks.create({ id: 'writer', num: 2, title: 'Writer', agent: 'claude', status: 'idle', cwd: root, folder: root, session: 'test2', desc: '' });
  const levels = { incoming: 1 as Level, outgoing: 1 as Level };
  // the fake Slack client records each post; nothing leaves this test
  const posts: Record<string, string>[] = [];
  const slack = { identity: () => ({ user: 'U1', team: 'T1' }), call: async (method: string, args: Record<string, string> = {}) => {
    if (method === 'users.info') return { user: { id: args.user, team_id: 'T1' } };
    if (method === 'conversations.open') return { channel: { id: 'D1' } };
    if (method === 'chat.postMessage') { posts.push(args); return { ts: String(posts.length) }; }
    return {};
  }, upload: async () => 'F1' } as unknown as SlackClient;
  // the review fixture: the verdict comes from a word in the text. A gate can hold the next review.
  const reviewed: string[] = [];
  let gate: Promise<void> | undefined;
  const verdict = (text: string): Verdict => /HOSTILE/.test(text) ? 'quarantine' : /UNSURE/.test(text) ? 'uncertain' : 'communication';
  const app = express(); app.use(express.json());
  const cleanup = mountMail(app, { background: false, slack, levels: () => levels, qualityReview: async body => ({ state: 'done', flags: [], suggestedBody: body, at: new Date().toISOString() }),
    review: async m => { const held = gate; if (held) await held; reviewed.push(m.body); return { verdict: verdict(m.subject + m.body), reason: 'Fixture', at: new Date().toISOString() }; } });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/mail`;
  const call = async (path: string, actor: 'user' | 'controller' | 'task', body?: unknown) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (actor === 'user') headers.origin = URL_BASE;
    else { headers['x-taskboard-token'] = TOKEN; headers['x-tb-actor'] = actor === 'task' ? 'writer' : 'controller'; }
    if (actor === 'controller') headers['x-tb-mail-controller'] = controllerMailToken;
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const store = new MailStore(join(root, 'server', 'mail.json'));
  const until = async (check: () => unknown) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 10)); assert.ok(check()); };
  const cardFor = (id: string) => approvals.all().find(a => a.state === 'pending' && (a.payload as { message?: string }).message === id);
  const edit = (m: Message, subject: string, body: string, actor: 'user' | 'controller' | 'task' = 'user', files = (m.files || []).filter(f => !f.longBody).map(f => f.id)) =>
    call(`/${m.id}/edit`, actor, { subject, body, files, hash: m.hash });
  try {
    // a task proposes a pitch. At level 1 the user approves it on a card.
    const proposed = await call('/propose', 'task', { to: 'U2', subject: 'Pitch', body: 'Line one.\nLine two.\nLine three.' });
    const id = proposed.data.id as string;
    await until(() => store.get(id).review && cardFor(id));
    const first = store.get(id);
    assert.equal((await call(`/${id}/approve`, 'user', { hash: first.hash })).status, 200);
    assert.equal(cardFor(id), undefined);

    // only the dashboard edits a draft
    assert.match((await edit(first, 'Pitch', 'Changed by the controller.', 'controller')).data.error, /Use the Taskboard page/);
    assert.equal((await edit(first, 'Pitch', 'Changed by the task.', 'task')).status, 400);
    assert.equal(store.get(id).body, first.body);

    // the edit stores the new text and a new hash, removes the approval, and the review runs again
    const reviews = reviewed.length;
    const saved = await edit(first, 'Pitch', 'Line one.\nLine three.');
    assert.equal(saved.status, 200);
    let after = store.get(id);
    assert.notEqual(after.hash, first.hash);
    assert.equal(after.approval, undefined);
    assert.equal(after.body, 'Line one.\nLine three.');
    assert.equal(after.edits?.length, 1);
    assert.deepEqual(after.versions?.map(v => [v.body, v.author, v.approval?.by]), [['Line one.\nLine two.\nLine three.', 'task', 'user']]);
    await until(() => store.get(id).review);
    assert.ok(reviewed.length > reviews);
    assert.equal(reviewed.at(-1), 'Line one.\nLine three.');
    // a new card waits for the new text
    const secondCard = cardFor(id)!;
    assert.match(secondCard.detail, /Edited by you/);
    assert.match(cardFor(id)!.detail, /Line one.\nLine three./);
    // the approval of the old text does not send the new text
    assert.equal((await call(`/${id}/send`, 'user', {})).status, 400);
    // an edit from an old copy of the message is refused
    assert.match((await edit(first, 'Pitch', 'Old copy.')).data.error, /message changed/);

    // after the user's edit, the controller cannot dismiss or restore the draft, and it reads only the latest text
    assert.match((await call(`/${id}/dismiss`, 'controller', {})).data.error, /user edited this draft/);
    const read = (await call('', 'controller')).data.messages.find((m: { id: string }) => m.id === id);
    assert.equal(read.body, 'Line one.\nLine three.');
    assert.equal(read.versions, undefined);

    // quarantine after an edit blocks the send
    after = store.get(id);
    await edit(after, 'Pitch', 'HOSTILE text.');
    // the edit ends the waiting card
    assert.equal(approvals.get(secondCard.id)?.state, 'expired');
    assert.match(approvals.get(secondCard.id)!.result!, /You edited the message/);
    await until(() => store.get(id).review);
    assert.equal(store.get(id).review?.verdict, 'quarantine');
    assert.equal(cardFor(id), undefined);
    assert.equal((await call(`/${id}/approve-send`, 'user', { hash: store.get(id).hash })).status, 400);
    assert.equal(posts.length, 0);

    // restore the earlier text from the history, then approve and send in one step
    after = store.get(id);
    const earlier = after.versions!.at(-1)!;
    await edit(after, earlier.subject, earlier.body);
    await until(() => store.get(id).review);
    after = store.get(id);
    assert.equal(after.body, 'Line one.\nLine three.');
    assert.equal(after.versions?.length, 3);
    const sent = await call(`/${id}/approve-send`, 'user', { hash: after.hash });
    assert.equal(sent.status, 200);
    assert.equal(posts.length, 1);
    for (const field of [posts[0].blocks, posts[0].text]) assert.ok(field.includes('Line one') && !field.includes('Line two'), 'Slack receives only the latest text');
    assert.equal(cardFor(id), undefined);
    // a sent message cannot be changed
    assert.match((await edit(store.get(id), 'Pitch', 'Too late.')).data.error, /sent message cannot be changed/);

    // no edit while Taskboard sends a message or when delivery is uncertain
    const other = store.add({ direction: 'outbox', source: 'user', from: 'U1', to: 'U2', subject: 'Other', body: 'Text.', proposedBy: { actor: 'user' } });
    store.update(other.id, m => { m.sending = true; });
    assert.match((await edit(store.get(other.id), 'Other', 'New.')).data.error, /sending this message now/);
    store.update(other.id, m => { m.error = 'Slack did not confirm delivery.'; });
    assert.match((await edit(store.get(other.id), 'Other', 'New.')).data.error, /Delivery is uncertain/);
    assert.equal((await call('', 'user')).data.messages.find((m: { id: string }) => m.id === other.id).editBlocked, 'Delivery is uncertain. Check the Slack conversation. The message cannot be changed.');

    // the history keeps the last 10 versions
    const many = store.add({ direction: 'outbox', source: 'user', from: 'U1', to: 'U2', subject: 'Many', body: 'Version 0', proposedBy: { actor: 'user' } });
    for (let i = 1; i <= 12; i++) assert.equal((await edit(store.get(many.id), 'Many', `Version ${i}`)).status, 200);
    const history = store.get(many.id);
    assert.equal(history.edits?.length, 12);
    assert.deepEqual(history.versions?.map(v => v.body), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(i => `Version ${i}`));

    // the user removes an attached file and restores it from the history
    const upload = await fetch(base + '/files/upload', { method: 'POST', headers: { origin: URL_BASE, 'content-type': 'application/octet-stream', 'x-mail-filename': 'notes.md' }, body: 'File notes.' });
    const staged = await upload.json();
    const withFile = await call('/draft', 'user', { to: 'U2', subject: 'Files', body: 'See the file.', files: [staged.id] });
    await until(() => store.get(withFile.data.id).review);
    const f = store.get(withFile.data.id);
    const path = f.files![0].path;
    assert.equal((await edit(f, 'Files', 'No file now.', 'user', [])).status, 200);
    assert.deepEqual(store.get(f.id).files, []);
    assert.ok(existsSync(path), 'a stored version keeps its file');
    assert.equal((await edit(store.get(f.id), 'Files', 'See the file.', 'user', [staged.id])).status, 200);
    assert.equal(store.get(f.id).files?.[0].name, 'notes.md');

    // a long text gets a new message.md file made from the edited text
    const long = 'Word '.repeat(700);
    assert.equal((await edit(store.get(f.id), 'Files', long, 'user', [staged.id])).status, 200);
    assert.deepEqual(store.get(f.id).files?.map(x => [x.name, !!x.longBody]), [['notes.md', false], ['message.md', true]]);

    // an edit during a review: the old result is dropped and the new text gets its own review
    let open!: () => void;
    gate = new Promise<void>(r => { open = r; });
    const raced = store.add({ direction: 'outbox', source: 'user', from: 'U1', to: 'U2', subject: 'Race', body: 'UNSURE first text', proposedBy: { actor: 'user' } });
    const pending = call(`/${raced.id}/review`, 'user', {});
    await new Promise(r => setTimeout(r, 50));
    assert.equal((await edit(store.get(raced.id), 'Race', 'Plain second text')).status, 200);
    gate = undefined; open(); await pending;
    await until(() => store.get(raced.id).review);
    assert.equal(store.get(raced.id).review?.verdict, 'communication');
    assert.equal(store.get(raced.id).error, undefined);

    // the levels still decide who approves an edited draft: at level 2 the controller approves a trusted,
    // ordinary text, and the user approves a text that the check is unsure about
    levels.outgoing = 2; messageLevelsChanged();
    await call('/trusted', 'user', { user: 'U2', name: 'Colleague', trusted: true });
    const level = await call('/propose', 'task', { to: 'U2', subject: 'Level', body: 'Plain.' });
    await until(() => store.get(level.data.id).review);
    await edit(store.get(level.data.id), 'Level', 'UNSURE now.');
    await until(() => store.get(level.data.id).review);
    assert.equal((await call(`/${level.data.id}/approve`, 'controller', { hash: store.get(level.data.id).hash })).status, 400);
    await edit(store.get(level.data.id), 'Level', 'Plain again.');
    await until(() => store.get(level.data.id).review);
    assert.equal((await call(`/${level.data.id}/approve`, 'controller', { hash: store.get(level.data.id).hash })).status, 200);
  } finally {
    cleanup(); await new Promise<void>(r => server.close(() => r())); rmSync(root, { recursive: true, force: true });
  }
});
