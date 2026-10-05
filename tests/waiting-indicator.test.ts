import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Approval, PendingItem, Task } from '../web/src/api.ts';
import type { WaitFilter, WaitTarget } from '../web/src/waitingSummary.ts';

// The web modules need a few browser objects when they load: api.ts opens the events socket, keys.ts reads
// localStorage. These stand-ins do nothing.
const store = new Map<string, string>();
const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
const g = globalThis as Record<string, unknown>;
Object.assign(g, {
  localStorage: storage, sessionStorage: storage, addEventListener: () => {}, removeEventListener: () => {},
  location: new URL('http://127.0.0.1/'), WebSocket: class { close() {} send() {} },
});
g.window = g;
const { WaitingChips } = await import('../web/src/components/WaitingChips.tsx');
const { entryForTask, stackEntries } = await import('../web/src/stack.ts');
const { hashKind, rowMatches, waitingChips, waitTarget } = await import('../web/src/waitingSummary.ts');

// The rows of the Waiting page, as waitingRows in Waiting.tsx makes them (Waiting.tsx loads the terminal, which Node
// cannot load): one row for each question card and each pending approval card, and one row for each waiting task
// that has no card.
function waitingRows(tasks: Task[], approvals: Approval[], pending: PendingItem[]) {
  const rows: { id: string; taskId?: string; item?: PendingItem; approval?: Approval; task?: Task }[] = [
    ...pending.map(i => ({ id: `p:${i.id}`, taskId: i.taskId, item: i })),
    ...approvals.filter(a => a.state === 'pending').map(a => ({ id: `a:${a.id}`, taskId: a.actor, approval: a })),
  ];
  const covered = new Set(rows.map(r => r.taskId));
  for (const t of tasks) if (['needs-you', 'stopped', 'review'].includes(t.status) && !covered.has(t.id)) rows.push({ id: `t:${t.id}`, taskId: t.id, task: t });
  return rows;
}

// The waiting indicator of the top bar (task 270): every count is a button, and a click goes to the place where the
// user acts. This repo has no DOM test runner: the test calls the component (it has no hooks), finds its <button>
// elements in the returned tree and calls their onClick. Native <button type="button"> elements start their click on
// Enter and on Space, so the test checks that each target is such a button and that no key handler replaces it.

const task = (id: string, num: number, status: Task['status'], waitMin = 5) => ({ id, num, title: 'Task ' + num, status, waitMin, agent: 'claude' }) as Task;
const card = (id: string, taskId: string, num: number) => ({ id, taskId, taskNum: num, taskTitle: 'Task ' + num, agent: 'claude', kind: 'choice', question: 'Q?', options: [], createdAt: '2026-10-05T10:00:00Z' }) as unknown as PendingItem;
const approval = (id: string, actor: string, state: Approval['state'] = 'pending') => ({ id, actor, action: 'git-merge', summary: 'merge', detail: '', created: '2026-10-05T10:01:00Z', state }) as Approval;

type Btn = ReactElement<{ type?: string; onClick?: () => void; onKeyDown?: unknown; 'aria-label'?: string; title?: string; className?: string; children?: ReactNode }>;
function buttons(node: ReactNode): Btn[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<{ children?: ReactNode }>;
  return [...(el.type === 'button' ? [el as Btn] : []), ...buttons(el.props.children)];
}

function setup(tasks: Task[], approvals: Approval[], pending: PendingItem[]) {
  const queue = tasks.filter(t => ['needs-you', 'stopped', 'review'].includes(t.status)).sort((a, b) => b.waitMin - a.waitMin);
  const rows = waitingRows(tasks, approvals, pending);
  const clicks: [WaitTarget, WaitFilter | 'all'][] = [];
  const props = { queue, tasks, approvals, pending, rows, act: (t: WaitTarget, k: WaitFilter | 'all') => { clicks.push([t, k]); }, triageKey: '' };
  const tree = WaitingChips(props);
  return { tree, btns: buttons(tree), clicks, html: renderToStaticMarkup(tree) };
}

test('nothing waits: no button, the text says so', () => {
  const { btns, html } = setup([task('t1', 1, 'working')], [], []);
  assert.equal(btns.length, 0);
  assert.match(html, /Nothing waiting/);
});

test('one item waits: one button, and its click shows that card in the stack', () => {
  const t = task('t1', 1, 'needs-you');
  const { btns, clicks, html } = setup([t], [], [card('c1', 't1', 1)]);
  assert.equal(btns.length, 1, 'one kind: no chips');
  assert.match(html, /1 waiting on you/);
  assert.equal(btns[0].props['aria-label'], '1 task waits on you, the longest for 5 min. Click to show its card.');
  btns[0].props.onClick!();
  assert.deepEqual(clicks, [[{ stack: 'p:c1' }, 'all']]);
  // the stack puts the entry with that id in front
  assert.equal(entryForTask(stackEntries([], [card('c1', 't1', 1)]), 'p:c1'), 'p:c1');
});

test('one task waits without a card: the click opens its task panel', () => {
  const { btns, clicks } = setup([task('t1', 1, 'review')], [], []);
  btns[0].props.onClick!();
  assert.deepEqual(clicks, [[{ task: 't1' }, 'all']]);
  assert.match(btns[0].props.title!, /Click to open the task panel/);
});

test('many items wait: the main count opens the Waiting page, each chip its own filter', () => {
  const tasks = [task('t1', 1, 'needs-you', 30), task('t2', 2, 'needs-you'), task('t3', 3, 'review'), task('t4', 4, 'review'), task('t5', 5, 'stopped'), task('t6', 6, 'working')];
  const pending = [card('c1', 't1', 1)];
  const approvals = [approval('a1', 't6'), approval('a2', 't6'), approval('x', 't6', 'expired')];
  const { btns, clicks, html } = setup(tasks, approvals, pending);
  // the counts of the top bar before task 270: 5 tasks waiting, 2 approval cards pending (the expired one is not counted)
  assert.match(html, /5 waiting on you/);
  const labels = btns.map(b => String(([] as ReactNode[]).concat(b.props.children)[0]));
  assert.deepEqual(labels.slice(1), ['2 to approve', '1 question', '1 needs input', '2 to review', '1 stopped']);
  for (const b of btns) b.props.onClick!();
  assert.deepEqual(clicks, [
    [{ waiting: 'all' }, 'all'],
    [{ waiting: 'decide' }, 'decide'],
    [{ stack: 'p:c1' }, 'question'],
    [{ task: 't2' }, 'input'],
    [{ waiting: 'review' }, 'review'],
    [{ task: 't5' }, 'stopped'],
  ]);
  assert.match(btns[4].props['aria-label']!, /^2 to review\. Click to open the Waiting page with the filter "Tasks to review"\.$/);
});

test('every target is a native button with a name, a tooltip and no key handler of its own (Enter and Space click it)', () => {
  const tasks = [task('t1', 1, 'needs-you'), task('t3', 3, 'review')];
  const { btns } = setup(tasks, [approval('a1', 't1')], [card('c1', 't1', 1)]);
  assert.ok(btns.length >= 3);
  for (const b of btns) {
    assert.equal(b.props.type, 'button');
    assert.equal(b.props.onKeyDown, undefined);
    assert.ok(b.props['aria-label'] && b.props.title, 'accessible name and tooltip');
  }
  const css = readFileSync('web/src/app.css', 'utf8') + readFileSync('web/src/mockup.css', 'utf8');
  assert.match(css, /\.attn \{[^}]*cursor: pointer/);
  assert.match(css, /\.attn-chip \{[^}]*cursor: pointer/);
  assert.match(css, /\.attn-chip:hover \{/);
  assert.match(css, /\.attn:focus-visible, \.attn-chip:focus-visible, \.rail-count:focus-visible \{ outline: 2px solid var\(--accent\)/);
});

test('the chips of the tasks add up to the main count, and only one kind shows no chips', () => {
  const q = [task('t1', 1, 'needs-you'), task('t2', 2, 'stopped'), task('t3', 3, 'review')];
  assert.equal(waitingChips(q, [], []).reduce((n, c) => n + c.n, 0), 3);
  assert.equal(setup([task('t1', 1, 'review'), task('t2', 2, 'review')], [], []).btns.length, 1);
  // only approval cards: the "to approve" chip shows, because the main count does not include it
  const only = setup([task('t1', 1, 'working')], [approval('a1', 't1')], []);
  assert.equal(only.btns.length, 1);
  only.btns[0].props.onClick!();
  assert.deepEqual(only.clicks, [[{ stack: 'a:a1' }, 'decide']]);
});

test('the Waiting page filters and the address', () => {
  const tasks = [task('t1', 1, 'needs-you'), task('t2', 2, 'review')];
  const rows = waitingRows(tasks, [], [card('c1', 't1', 1)]);
  assert.deepEqual(rows.filter(r => rowMatches('needs', r, tasks, [card('c1', 't1', 1)])).map(r => r.id), ['p:c1']);
  assert.deepEqual(rows.filter(r => rowMatches('review', r, tasks, [])).map(r => r.id), ['t:t2']);
  assert.deepEqual(waitTarget([], 'review'), { waiting: 'review' });
  assert.equal(hashKind('#waiting:review'), 'review');
  assert.equal(hashKind('#waiting:needs'), 'needs');
  assert.equal(hashKind('#waiting'), null);
  assert.equal(hashKind('#waiting:other'), null);
});
