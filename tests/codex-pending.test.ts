import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
const root = mkdtempSync(join(tmpdir(), 'tb-codex-pending-'));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
const pending = await import('../server/pending.ts');
import { parsePrompt } from '../server/screen-prompts.ts';
import type { Task } from '../server/store.ts';

const choice = readFileSync(new URL('./fixtures/screens/codex-choice-question.txt', import.meta.url), 'utf8');
const collapsed = '• May I start a dedicated Taskboard task to replace the old scope advice?\n  • Start the task\n  • I will remove the old scope\n• Queued follow-up inputs\n  ? 1 question · 18s\n    shift+← to answer\n› Ask Codex to do anything';
const tasks = new Map<string, Task>();
const screens = new Map<string, string>();
const sent: [string, string, boolean][] = [];
const intercept = new Map<string, (key: string) => boolean>();
let captureDelay: (() => Promise<void>) | undefined;
pending.setIo({
  getTask: id => tasks.get(id),
  capture: async session => { await captureDelay?.(); return screens.get(session) || ''; },
  cancelCopyMode: async () => {},
  sendText: async () => { throw new Error('A screen answer must never use the follow-up queue.'); },
  key: async (session, key, literal) => {
    sent.push([session, key, literal]);
    if (intercept.get(session)?.(key)) return;
    if (key === 'S-Left') { screens.set(session, choice); return; }
    const cur = screens.get(session)!;
    const p = parsePrompt('codex', cur)!;
    if (key === 'Enter') { screens.set(session, '› Ask Codex to do anything'); return; }
    if (literal) { screens.set(session, cur.replace(/› (Add notes|Type your answer \(optional\))/, `› ${key}`)); return; }
    if (key === 'Tab') { screens.set(session, cur.replace('  tab to add notes', '  › Add notes\n\n  tab or esc to clear notes')); return; }
    const next = p.selected + (key === 'Down' ? 1 : -1);
    screens.set(session, cur.replace(/› (\d+)\./, '  $1.').replace(new RegExp(`  ${next + 1}\\.`), `› ${next + 1}.`));
  },
  wait: async () => {}, log: () => {}, answered: () => {},
});
function task(id: string, screen = choice) {
  const t = { id, num: 216, title: 'Screen test', agent: 'codex', session: id, status: 'needs-you' } as Task;
  tasks.set(id, t); screens.set(id, screen); pending.scan(t, screen);
  return pending.list().find(i => i.taskId === id)!;
}
const keys = (id: string) => sent.filter(x => x[0] === id).map(x => x[1]);

test('screenshot question opens before offering answer controls and rejects a stale collapsed screen', async () => {
  const item = task('inspect', collapsed);
  assert.equal(item.inspect, true);
  assert.equal(item.answerable, false);
  const opened = await pending.inspect(item.id);
  assert.deepEqual(opened.options.map(o => o.label), ['Start the task', 'I will remove the old scope']);
  assert.deepEqual(keys('inspect'), ['S-Left']);
  await pending.answer(opened.id, { option: 'o1', by: 'user' });
  assert.deepEqual(keys('inspect'), ['S-Left', 'Down', 'Enter']);
  const stale = task('inspect-stale', collapsed);
  screens.set('inspect-stale', collapsed.replace('Start the task', 'Stop the task'));
  await assert.rejects(pending.inspect(stale.id), /out of date/);
  assert.deepEqual(keys('inspect-stale'), []);
});

test('two simultaneous clicks and a later retry send one selected answer', async () => {
  const item = task('duplicate');
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  captureDelay = () => barrier;
  const first = pending.answer(item.id, { option: 'o1', by: 'user' });
  await assert.rejects(pending.answer(item.id, { option: 'o0', by: 'user' }), /being answered/);
  release(); captureDelay = undefined;
  await first;
  await assert.rejects(pending.answer(item.id, { option: 'o1', by: 'user' }), /closed/);
  assert.deepEqual(keys('duplicate'), ['Down', 'Enter']);
});

test('changed question before a click or between arrow keys refuses Enter', async () => {
  const item = task('stale');
  screens.set('stale', choice.replace('May I start', 'May I cancel'));
  await assert.rejects(pending.answer(item.id, { option: 'o0', by: 'user' }), /not the one/);
  assert.deepEqual(keys('stale'), []);
  const moved = task('changed');
  intercept.set('changed', key => { if (key === 'Down') { screens.set('changed', choice.replace('yourself.', 'later.')); return true; } return false; });
  await assert.rejects(pending.answer(moved.id, { option: 'o1', by: 'user' }), /prompt changed/);
  assert.deepEqual(keys('changed'), ['Down']);
  assert.equal(pending.get(moved.id)!.answerable, false);
});

test('choice text selects None of the above and verifies exact text before Enter', async () => {
  const item = task('text-choice');
  await pending.answer(item.id, { text: 'start', by: 'user' });
  assert.deepEqual(keys('text-choice'), ['Down', 'Down', 'Tab', 'start', 'Enter']);
  assert.match(pending.get(item.id)!.answer!.sent, /"start"/);
});

test('freeform text, existing draft, text changed before Enter, and long text', async () => {
  const freeform = 'Question 1/1 (1 unanswered)\nWhat name should I use?\n\n› Type your answer (optional)\n\nenter to submit answer | esc to interrupt';
  const item = task('freeform', freeform);
  await pending.answer(item.id, { text: 'Project A', by: 'user' });
  assert.deepEqual(keys('freeform'), ['Project A', 'Enter']);
  const draft = task('draft', freeform.replace('Type your answer (optional)', 'existing text'));
  assert.equal(draft.answerable, false);
  await assert.rejects(pending.answer(draft.id, { text: 'new text', by: 'user' }), /cannot answer/);
  const changed = task('text-changed', freeform);
  intercept.set('text-changed', key => { if (key === 'start') { screens.set('text-changed', freeform.replace('Type your answer (optional)', 'start changed')); return true; } return false; });
  await assert.rejects(pending.answer(changed.id, { text: 'start', by: 'user' }), /exact text/);
  assert.deepEqual(keys('text-changed'), ['start']);
  const long = task('long', freeform);
  await assert.rejects(pending.answer(long.id, { text: 'a'.repeat(101), by: 'user' }), /100 characters/);
  assert.deepEqual(keys('long'), []);
});

test('Enter without a confirmed screen change cannot be sent again after scanning', async () => {
  const item = task('no-ack');
  intercept.set('no-ack', key => key === 'Enter');
  await assert.rejects(pending.answer(item.id, { option: 'o0', by: 'user' }), /still shows/);
  pending.scan(tasks.get('no-ack')!, choice);
  assert.equal(pending.get(item.id)!.answerable, false);
  await assert.rejects(pending.answer(item.id, { option: 'o0', by: 'user' }), /cannot answer/);
  assert.deepEqual(keys('no-ack'), ['Enter']);
});

test('Not a question hides a parsed screen without typing an answer', () => {
  const item = task('hidden');
  pending.hide(item.id);
  pending.scan(tasks.get('hidden')!, choice);
  assert.equal(pending.list().some(i => i.taskId === 'hidden'), false);
  assert.deepEqual(keys('hidden'), []);
});

test('screen routes require the dashboard and use POST for receipt reads', async () => {
  const { default: express } = await import('express');
  const { mountPendingScreenRoutes } = await import('../server/pending-screen-routes.ts');
  const app = express(); app.use(express.json());
  let receiptReads = 0;
  const origin = 'http://127.0.0.1:4495';
  mountPendingScreenRoutes(app, { originOk: o => o === origin, replyStatus: () => { receiptReads++; return null; } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const card = task('route', collapsed);
  const post = (path: string, headers = { origin } as Record<string, string>) => fetch(`${base}/api/pending/${card.id}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
  try {
    assert.equal((await post('reply/status')).status, 200);
    assert.equal(receiptReads, 1);
    assert.equal((await post('reply/status', {})).status, 403);
    assert.equal((await post('reply/status', { origin: 'http://untrusted.invalid' })).status, 403);
    assert.equal((await post('inspect', { origin, 'x-tb-actor': 'controller' })).status, 403);
    assert.equal((await post('inspect', { origin, 'x-taskboard-token': 'agent-token' })).status, 403);
    const legacy = await post('reply');
    assert.equal(legacy.status, 409);
    assert.match((await legacy.json()).error, /queued nothing/);
    assert.deepEqual(keys('route'), []);
    const opened = await post('inspect');
    assert.equal(opened.status, 200);
    assert.equal((await opened.json()).kind, 'choice');
    assert.equal((await post('inspect')).status, 409);
    assert.deepEqual(keys('route'), ['S-Left']);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

const asyncChoice = readFileSync(new URL('./fixtures/screens/codex-async-question.txt', import.meta.url), 'utf8');
test('async question from #216: open the composer and send a selected answer or exact Other text', async () => {
  const item = task('async-choice', asyncChoice);
  assert.equal(item.answerable, true);
  assert.deepEqual(item.options.map(o => o.label), ['Start the task', 'I will remove the old scope']);
  await pending.answer(item.id, { option: 'o1', by: 'user' });
  assert.deepEqual(keys('async-choice'), ['Down', 'Enter']);
  const text = task('async-text', asyncChoice);
  intercept.set('async-text', key => {
    if (key === 'start') {
      screens.set('async-text', screens.get('async-text')!.replace('3. Other', '3. start'));
      return true;
    }
    return false;
  });
  await pending.answer(text.id, { text: 'start', by: 'user' });
  assert.deepEqual(keys('async-text'), ['Down', 'Down', 'start', 'Enter']);
});

test('collapsed async question is replaced by its verified composer', async () => {
  const item = task('async-inspect', collapsed);
  intercept.set('async-inspect', key => { if (key === 'S-Left') { screens.set('async-inspect', asyncChoice); return true; } return false; });
  const opened = await pending.inspect(item.id);
  assert.equal(opened.name, 'codex-async-question');
  assert.equal(opened.answerable, true);
});
