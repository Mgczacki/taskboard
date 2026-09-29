import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { incomingApprover, outgoingApprover, type Level } from '../server/mail/policy.ts';
import type { Verdict } from '../server/mail/store.ts';
import type { SlackClient } from '../server/mail/slack.ts';

test('the approver tables for each level and direction', () => {
  const verdicts: (Verdict | undefined)[] = [undefined, 'quarantine', 'action-request', 'uncertain', 'communication'];
  // rows: no review, quarantine, action-request, uncertain, communication; columns: level 1, 2, 3
  const incomingTrusted = [['nobody', 'nobody', 'nobody'], ['nobody', 'nobody', 'nobody'], ['user', 'user', 'nobody'], ['user', 'user', 'controller'], ['user', 'controller', 'controller']];
  const incomingUntrusted = [['nobody', 'nobody', 'nobody'], ['nobody', 'nobody', 'nobody'], ['user', 'user', 'nobody'], ['user', 'user', 'user'], ['user', 'user', 'user']];
  const outgoingTrusted = [['nobody', 'nobody', 'nobody'], ['nobody', 'nobody', 'nobody'], ['user', 'user', 'user'], ['user', 'user', 'controller'], ['user', 'controller', 'controller']];
  const outgoingUntrusted = [['nobody', 'nobody', 'nobody'], ['nobody', 'nobody', 'nobody'], ['user', 'user', 'user'], ['user', 'user', 'user'], ['user', 'user', 'user']];
  verdicts.forEach((v, row) => ([1, 2, 3] as Level[]).forEach((level, col) => {
    assert.equal(incomingApprover(v, level, true), incomingTrusted[row][col], `incoming trusted ${v} level ${level}`);
    assert.equal(incomingApprover(v, level, false), incomingUntrusted[row][col], `incoming untrusted ${v} level ${level}`);
    assert.equal(outgoingApprover(v, level, true), outgoingTrusted[row][col], `outgoing trusted ${v} level ${level}`);
    assert.equal(outgoingApprover(v, level, false), outgoingUntrusted[row][col], `outgoing untrusted ${v} level ${level}`);
  }));
});

test('the Inbox checkbox that was off becomes outgoing level 1', () => {
  const root = mkdtempSync(join(tmpdir(), 'mail-levels-migrate-'));
  try {
    const read = (mail: unknown) => {
      const dir = join(root, String(Math.random())); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'machine.json'), JSON.stringify({ name: 'test' }));
      if (mail) writeFileSync(join(dir, 'mail.json'), JSON.stringify(mail));
      const out = execFileSync(process.execPath, ['--import', 'tsx', '-e', `import('${resolve('server/machine.ts')}').then(m => console.log(JSON.stringify(m.get().messages)))`],
        { env: { ...process.env, TASKBOARD_DIR: dir, TASKBOARD_VAULT: join(dir, 'vault') }, encoding: 'utf8' });
      return { levels: JSON.parse(out), saved: JSON.parse(readFileSync(join(dir, 'machine.json'), 'utf8')).messages };
    };
    assert.deepEqual(read({ version: 1, messages: [], contacts: [], controllerApproval: false }), { levels: { incoming: 2, outgoing: 1 }, saved: { incoming: 2, outgoing: 1 } });
    assert.deepEqual(read({ version: 1, messages: [], contacts: [], controllerApproval: true }).levels, { incoming: 2, outgoing: 2 });
    assert.deepEqual(read(undefined).levels, { incoming: 2, outgoing: 2 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the server enforces the levels for approval, routing, sending and cards', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mail-levels-'));
  process.env.TASKBOARD_DIR = join(root, 'server'); process.env.TASKBOARD_VAULT = join(root, 'vault');
  const { mountMail, messageLevelsChanged } = await import('../server/mail/routes.ts');
  const { TOKEN, URL_BASE } = await import('../server/config.ts');
  const { controllerMailToken } = await import('../server/mail/auth.ts');
  const { MailStore } = await import('../server/mail/store.ts');
  const approvals = await import('../server/approvals.ts');
  const machine = await import('../server/machine.ts');
  const tasks = await import('../server/store.ts');
  tasks.create({ id: 'worker', num: 1, title: 'Worker', agent: 'claude', status: 'idle', cwd: root, folder: root, session: 'test', desc: '' });
  tasks.create({ id: 'writer', num: 2, title: 'Writer', agent: 'claude', status: 'idle', cwd: root, folder: root, session: 'test2', desc: '' });
  const levels = { incoming: 1 as Level, outgoing: 1 as Level };
  const notices: { task: string; text: string }[] = [];
  const verdictFor: Record<string, Verdict> = {};
  const slack = { identity: () => ({ user: 'U1', team: 'T1' }), call: async (method: string, args: Record<string, string> = {}) => {
    if (method === 'users.info') return { user: { id: args.user, team_id: 'T1' } };
    if (method === 'conversations.open') return { channel: { id: 'D1' } };
    if (method === 'chat.postMessage') return { ts: '1' };
    return {};
  } } as unknown as SlackClient;
  const app = express(); app.use(express.json());
  const cleanup = mountMail(app, { background: false, slack, levels: () => levels, notify: (task, _name, text) => { notices.push({ task, text }); },
    review: async m => { if (verdictFor[m.subject] === undefined) throw new Error('model down'); return { verdict: verdictFor[m.subject], reason: 'Fixture', at: new Date().toISOString() }; } });
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
  const incoming = async (subject: string, verdict: Verdict | undefined, from = 'U2') => {
    if (verdict) verdictFor[subject] = verdict;
    const m = store.add({ direction: 'inbox', source: 'slack', from, to: 'U1', subject, body: `Body of ${subject}` });
    await call(`/${m.id}/review`, 'user', {});
    return store.get(m.id);
  };
  const shown = async (id: string) => (await call('', 'controller')).data.messages.find((m: { id: string }) => m.id === id);
  const cardFor = (id: string) => approvals.all().find(a => a.state === 'pending' && (a.payload as { message?: string }).message === id);
  try {
    // only the dashboard changes the trusted list
    assert.equal((await call('/trusted', 'controller', { user: 'U2', trusted: true })).status, 400);
    assert.equal((await call('/trusted', 'user', { user: 'U2', name: 'Colleague', trusted: true })).status, 200);

    // level 1: the controller proposes the task, the user approves the message and the task on the card
    const one = await incoming('Level one', 'communication');
    assert.equal((await shown(one.id)).approver, 'user');
    assert.equal((await call(`/${one.id}/approve`, 'controller', { hash: one.hash })).status, 400);
    assert.equal((await call(`/${one.id}/route`, 'controller', { task: 'worker' })).status, 400);
    assert.match(notices.at(-1)!.text, /propose-route/);
    assert.ok(!notices.at(-1)!.text.includes('Body of'));
    assert.equal(cardFor(one.id), undefined);
    assert.equal((await call(`/${one.id}/propose-route`, 'controller', { task: 'worker' })).status, 200);
    const card = cardFor(one.id)!;
    assert.equal(card.action, 'mail-in');
    assert.match(card.detail, /Body of Level one/);
    // Send back goes to the controller with the comment and removes the proposed task
    await approvals.giveBack(card.id, 'Route it to the writer task.');
    assert.equal(notices.at(-1)!.task, 'controller');
    assert.match(notices.at(-1)!.text, /Route it to the writer task/);
    assert.equal(store.get(one.id).proposedRoute, undefined);
    await call(`/${one.id}/propose-route`, 'controller', { task: 'writer' });
    await approvals.decide(cardFor(one.id)!.id, true);
    assert.equal(store.get(one.id).approval?.by, 'user');
    assert.equal(store.get(one.id).routes[0].task, 'writer');
    assert.ok(existsSync(join(tasks.taskDir('writer'), 'inbox', `mail-${one.id}.md`)));

    // a restart makes the card again from mail.json
    const two = await incoming('Waiting card', 'uncertain');
    await call(`/${two.id}/propose-route`, 'controller', { task: 'worker' });
    approvals.close(cardFor(two.id)!.id, 'expired', 'Restart');
    const again = express(); again.use(express.json());
    const cleanupAgain = mountMail(again, { background: false, slack, levels: () => levels });
    assert.ok(cardFor(two.id));
    cleanupAgain(); approvals.close(cardFor(two.id)!.id, 'expired', 'Second module in this test');
    // approving in Inbox closes the card
    const five = await incoming('Approved in Inbox', 'uncertain');
    await call(`/${five.id}/propose-route`, 'controller', { task: 'worker' });
    assert.ok(cardFor(five.id));
    await call(`/${five.id}/approve`, 'user', { hash: five.hash });
    assert.equal(cardFor(five.id), undefined);

    // level 2: the controller approves and routes a trusted, ordinary message by its own judgment
    levels.incoming = 2; messageLevelsChanged();
    const three = await incoming('Level two', 'communication');
    assert.equal((await shown(three.id)).body, 'Body of Level two');
    assert.equal((await call(`/${three.id}/approve`, 'controller', { hash: three.hash })).status, 200);
    assert.equal((await call(`/${three.id}/route`, 'controller', { task: 'worker' })).status, 200);
    assert.equal(store.get(three.id).unseen, true);
    const unsure = await incoming('Unsure', 'uncertain');
    assert.equal((await call(`/${unsure.id}/approve`, 'controller', { hash: unsure.hash })).status, 400);
    // an unknown sender needs the user at every level
    levels.incoming = 3;
    const stranger = await incoming('Stranger', 'communication', 'U9');
    assert.equal((await shown(stranger.id)).approver, 'user');
    assert.equal((await call(`/${stranger.id}/approve`, 'controller', { hash: stranger.hash })).status, 400);

    // level 3: a failed safety check or quarantine has no approver, and the controller does not see the text
    const risky = await incoming('Grant access', 'action-request');
    assert.equal((await shown(risky.id)).body, '');
    assert.equal((await call(`/${risky.id}/approve`, 'user', { hash: risky.hash })).status, 400);
    const hostile = await incoming('Hostile', 'quarantine');
    assert.equal((await call(`/${hostile.id}/approve`, 'user', { hash: hostile.hash })).status, 400);
    // a failed review leaves the message with no approver
    const failed = await incoming('Model down', undefined);
    assert.equal((await shown(failed.id)).approver, 'nobody');
    // a controller approval stops counting when the user raises the level
    const four = await incoming('Approved at three', 'uncertain');
    assert.equal((await call(`/${four.id}/approve`, 'controller', { hash: four.hash })).status, 200);
    levels.incoming = 1; messageLevelsChanged();
    assert.equal((await call(`/${four.id}/route`, 'controller', { task: 'worker' })).status, 400);

    // outgoing level 2: the controller approves and sends a draft to a trusted person
    levels.outgoing = 2;
    verdictFor.Status = 'communication';
    const draft = await call('/propose', 'task', { to: 'U2', subject: 'Status', body: 'Ready.' });
    await call(`/${draft.data.id}/review`, 'user', {});
    assert.match(notices.at(-1)!.text, /tb mail send/);
    const d = store.get(draft.data.id);
    assert.equal((await call(`/${d.id}/approve`, 'controller', { hash: d.hash })).status, 200);
    levels.outgoing = 1;
    assert.equal((await call(`/${d.id}/send`, 'controller', {})).status, 400);
    levels.outgoing = 2;
    assert.equal((await call(`/${d.id}/send`, 'controller', {})).status, 200);
    // a draft to a person who is not trusted gets a card, and Send back goes to the task that wrote it
    const other = await call('/propose', 'task', { to: 'U7', subject: 'Status', body: 'Ready.' });
    await call(`/${other.data.id}/review`, 'user', {});
    const outCard = cardFor(other.data.id)!;
    assert.equal(outCard.action, 'mail-out');
    assert.equal(outCard.actor, 'writer');
    await approvals.giveBack(outCard.id, 'Do not send this yet.');
    assert.equal(notices.at(-1)!.task, 'writer');
    assert.ok(store.get(other.data.id).rejectedAt);
    // Approve on an outgoing card sends the draft
    const third = await call('/propose', 'task', { to: 'U8', subject: 'Status', body: 'Ready.' });
    await call(`/${third.data.id}/review`, 'user', {});
    const sent = await approvals.decide(cardFor(third.data.id)!.id, true);
    assert.equal(sent?.state, 'approved');
    assert.ok(store.get(third.data.id).sentAt);
    assert.equal(machine.get().messages.incoming, 2); // the test levels never touch machine.json
  } finally {
    cleanup(); await new Promise<void>(r => server.close(() => r())); rmSync(root, { recursive: true, force: true });
  }
});
