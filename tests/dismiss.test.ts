// Dismiss on the Waiting page: signatures, the store and its limits, Bring back, the return of an item when its
// signature changes, the 10-minute rule for a held Claude permission card, and the Dismissed view (server/dismiss.ts,
// web/src/dismissRules.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as dismiss from '../server/dismiss.ts';
import * as pending from '../server/pending.ts';
import type { Task } from '../server/store.ts';
import type { Dismissal, PendingItem, Task as WebTask } from '../web/src/api.ts';
import { dismissedList, quietTaskIds } from '../web/src/dismissRules.ts';

const tasks = new Map<string, Task>();
const task = (id: string, num: number, extra: Partial<Task> = {}) => {
  const t = { id, num, title: `Task ${num}`, agent: 'claude', session: `s-${id}`, status: 'needs-you', cwd: '/tmp', statusAt: '2026-10-02T10:00:00.000Z', ...extra } as Task;
  tasks.set(id, t); return t;
};
pending.setIo({ capture: async () => '', key: async () => {}, cancelCopyMode: async () => {}, sendText: async () => ({ submitted: true }),
  getTask: id => tasks.get(id), log: () => {}, answered: () => {}, wait: async () => {} });
const fresh = () => { dismiss.reset(); dismiss.load(mkdtempSync(join(tmpdir(), 'tb-dismiss-'))); };
const entry = (sig: string, extra: Partial<Dismissal> = {}) => ({ sig, kind: 'item' as const, taskId: 't1', taskNum: 1, title: 'T', question: 'Q?', label: 'Question', ...extra });
const turnEnd = (t: Task, q: string) => { t.statusSource = 'Stop hook'; t.ask = q; pending.scan(t, ''); return pending.list().find(i => i.taskId === t.id)!; };

test('a screen or end-of-turn card has no item id in its signature; a held hook card has it', () => {
  assert.equal(dismiss.itemSignature({ source: 'screen', taskId: 't1', id: 'a1' }, 'S'), dismiss.itemSignature({ source: 'screen', taskId: 't1', id: 'b2' }, 'S'));
  assert.notEqual(dismiss.itemSignature({ source: 'screen', taskId: 't1', id: 'a1' }, 'S'), dismiss.itemSignature({ source: 'screen', taskId: 't2', id: 'a1' }, 'S'));
  assert.notEqual(dismiss.itemSignature({ source: 'claude-hook', taskId: 't1', id: 'a1' }, 'S'), dismiss.itemSignature({ source: 'claude-hook', taskId: 't1', id: 'b2' }, 'S'));
});

test('a task row signature changes with the status, the text, the status time and the review document version', () => {
  const t = { id: 't1', status: 'needs-you', ask: 'Pick one', statusAt: '2026-10-02T10:00:00Z' };
  const base = dismiss.taskSignature(t);
  assert.equal(dismiss.taskSignature({ ...t }), base);
  assert.notEqual(dismiss.taskSignature({ ...t, status: 'stopped' }), base);
  assert.notEqual(dismiss.taskSignature({ ...t, ask: 'Pick two' }), base);
  assert.notEqual(dismiss.taskSignature({ ...t, statusAt: '2026-10-02T10:05:00Z' }), base);
  const r = { ...t, status: 'review', ask: 'Review plan.md' };
  assert.notEqual(dismiss.taskSignature(r, { id: 'd1', version: 1 }), dismiss.taskSignature(r, { id: 'd1', version: 2 }));
  // stopReason is the waiting text of a stopped task
  assert.notEqual(dismiss.taskSignature({ id: 't1', status: 'stopped', stopReason: 'A', statusAt: 'x' }), dismiss.taskSignature({ id: 't1', status: 'stopped', stopReason: 'B', statusAt: 'x' }));
});

test('the store keeps a dismiss in the file, and a new load reads it back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-dismiss-'));
  dismiss.reset(); dismiss.load(dir);
  dismiss.dismiss(entry('s1'), false);
  assert.ok(dismiss.isDismissed('s1'));
  assert.equal(JSON.parse(readFileSync(join(dir, 'dismissed.json'), 'utf8')).entries[0].sig, 's1');
  dismiss.reset(); assert.ok(!dismiss.isDismissed('s1'));
  dismiss.load(dir); assert.ok(dismiss.isDismissed('s1'));
});

test('Bring back removes the entry; a second dismiss of the same item keeps one entry', () => {
  fresh();
  dismiss.dismiss(entry('s1'), false); dismiss.dismiss(entry('s1'), false);
  assert.equal(dismiss.all().length, 1);
  assert.equal(dismiss.bringBack('s1'), true);
  assert.equal(dismiss.isDismissed('s1'), false);
  assert.equal(dismiss.bringBack('s1'), false);
});

test('prune drops entries older than 30 days, entries of gone items after the grace time, and keeps at most MAX', () => {
  fresh();
  const now = Date.parse('2026-10-02T12:00:00Z');
  dismiss.dismiss(entry('old'), false, now - dismiss.MAX_AGE_MS - 1000);
  dismiss.dismiss(entry('live'), false, now);
  dismiss.dismiss(entry('gone'), false, now);
  const live = new Set(['old', 'live']);
  dismiss.prune(live, now);
  assert.deepEqual(dismiss.all(now).map(e => e.sig).sort(), ['gone', 'live']);   // gone: inside the grace time
  dismiss.prune(live, now + dismiss.GONE_MS - 1000);
  assert.ok(dismiss.isDismissed('gone', now));
  dismiss.prune(live, now + dismiss.GONE_MS + 1000);
  assert.deepEqual(dismiss.all(now).map(e => e.sig), ['live']);
  // an item that comes back inside the grace time (a screen card read again) keeps its entry
  dismiss.dismiss(entry('resized'), false, now);
  dismiss.prune(new Set(['live']), now);
  dismiss.prune(new Set(['live', 'resized']), now + 30_000);
  dismiss.prune(new Set(['live', 'resized']), now + dismiss.GONE_MS + 60_000);
  assert.ok(dismiss.isDismissed('resized', now));
  for (let n = 0; n < dismiss.MAX + 20; n++) dismiss.dismiss(entry(`n${n}`), false, now);
  assert.equal(dismiss.all(now).length, dismiss.MAX);
  assert.ok(dismiss.isDismissed(`n${dismiss.MAX + 19}`, now));   // the newest stay
});

test('a dismissed question card is marked; a new question in the same task shows again', () => {
  fresh();
  const t = task('q1', 11);
  const first = turnEnd(t, 'Which branch should I use?');
  dismiss.dismiss(entry(first.sig!, { taskId: t.id }), false);
  const marked = pending.list().find(i => i.id === first.id)!;
  assert.ok(marked.dismissed?.at);
  assert.equal(marked.state, 'pending');                 // the card is not answered and not closed
  const second = turnEnd(t, 'Should I also update the tests?');
  assert.notEqual(second.sig, first.sig);
  assert.equal(second.dismissed, undefined);
  pending.forgetTask(t.id);
});

test('an answer drops the dismiss of its card, so the same question later shows again', async () => {
  fresh();
  const t = task('q2', 12);
  const card = turnEnd(t, 'Ready to merge?');
  dismiss.dismiss(entry(card.sig!, { taskId: t.id }), false);
  await pending.answer(card.id, { text: 'yes', by: 'user' });
  assert.equal(dismiss.isDismissed(card.sig), false);
  pending.forgetTask(t.id);
});

test('a held Claude permission card: the dismiss does not answer or release the hook, and ends after 10 minutes', async () => {
  fresh();
  const t = task('h1', 13);
  let resolved = false;
  const held = pending.holdClaude(t, { tool_name: 'Bash', tool_input: { command: 'ls', description: 'list' } }, () => {}, 3600_000).then(o => { resolved = true; return o; });
  const card = pending.list().find(i => i.taskId === t.id)!;
  assert.ok(pending.holdsHook(card));
  const now = Date.now();
  const d = dismiss.dismiss(entry(card.sig!, { taskId: t.id }), pending.holdsHook(card), now);
  assert.equal(Date.parse(d.until!) - now, dismiss.HOOK_MS);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(resolved, false);                          // the hook still waits
  assert.equal(pending.list().find(i => i.id === card.id)?.state, 'pending');
  assert.ok(dismiss.isDismissed(card.sig, now + dismiss.HOOK_MS - 1000));
  assert.equal(dismiss.isDismissed(card.sig, now + dismiss.HOOK_MS + 1000), false);
  // the answer logic is unchanged: the card can still be answered
  await pending.answer(card.id, { option: 'no', by: 'user' });
  assert.equal(resolved, true);
  await held;
});

test('quiet tasks: a dismissed task row, or only dismissed cards, leave the counts; a shown card keeps the task', () => {
  const t = (id: string, status: WebTask['status'], waitSig?: string) => ({ id, status, waitSig });
  const quiet = quietTaskIds([t('a', 'needs-you', 'sa'), t('b', 'needs-you', 'sb'), t('c', 'needs-you', 'sc'), t('d', 'working', 'sd')],
    [{ taskId: 'c' }], [{ taskId: 'b' }, { taskId: 'c' }], [{ sig: 'sa' }, { sig: 'sd' }]);
  assert.deepEqual([...quiet].sort(), ['a', 'b']);
});

test('the Dismissed view lists newest first, with the card or task only while the signature is the same', () => {
  const d = (sig: string, at: string, kind: 'item' | 'task', taskId: string) => ({ sig, at, kind, taskId, taskNum: 1, title: 'T', question: 'Q', label: 'L' }) as Dismissal;
  const items = [{ id: 'p1', sig: 'i1', taskId: 't1', dismissed: { at: 'x' } }] as unknown as PendingItem[];
  const list = dismissedList([d('i1', '2026-10-02T10:00:00Z', 'item', 't1'), d('w2', '2026-10-02T11:00:00Z', 'task', 't2'), d('w3', '2026-10-02T09:00:00Z', 'task', 't3')], items,
    [{ id: 't2', waitSig: 'w2' }, { id: 't3', waitSig: 'new' }]);
  assert.deepEqual(list.map(x => x.dismissal.sig), ['w2', 'i1', 'w3']);
  assert.equal(list[0].task?.id, 't2');
  assert.equal(list[1].item?.id, 'p1');
  assert.equal(list[2].task, undefined);           // t3 has a new signature: it shows in the normal views again
});

test('the Waiting page has a Dismissed tab after Answered, and the task row has Open task panel, Dismiss, Set aside in that order', () => {
  const src = readFileSync(new URL('../web/src/components/Waiting.tsx', import.meta.url), 'utf8');
  assert.match(src, /\['answered', 'Answered'\], \['dismissed', 'Dismissed'\]/);
  const row = src.slice(src.indexOf('>Open task panel</button>'), src.indexOf('>Set aside</button>'));
  assert.ok(row.includes('>Dismiss</button>'));
});
