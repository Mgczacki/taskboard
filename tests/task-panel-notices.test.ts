// The task panel header of task 280: the notice list and the strip (taskNotices.ts, NoticeStrip.tsx), the saved fold
// state of the info section, the More menu (panelMore.ts) and the height that the CSS leaves for the terminal. This repo
// has no DOM test runner: the tests call the hook-free view NoticeStripView and the handlers of its buttons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const store = new Map<string, string>();
const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
const g = globalThis as Record<string, unknown>;
Object.assign(g, {
  localStorage: storage, sessionStorage: storage, addEventListener: () => {}, removeEventListener: () => {},
  location: new URL('http://127.0.0.1/'), WebSocket: class { close() {} send() {} },
});
g.window = g;
const { api } = await import('../web/src/api.ts');
const N = await import('../web/src/taskNotices.ts');
const { NoticeStripView, noticeActions } = await import('../web/src/components/NoticeStrip.tsx');
const { moreItems } = await import('../web/src/panelMore.ts');
type Task = import('../web/src/api.ts').Task;
type Q = NonNullable<Task['queue']>[number];

const now = Date.parse('2026-10-05T09:30:00.000Z');
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
// the two cards of the screenshot of task 216
const failedTyping: Q = { id: 'af981069', kind: 'message', from: 'Taskboard', text: '[Taskboard event digest, 8 events]', state: 'failed', reason: 'The text did not arrive whole in the input box of Claude Code in #216 within 15 s. Enter was not pressed.', queued: ago(150), hook: 'it calls a tool, you send a prompt or a turn ends' };
const failedDialog: Q = { id: '9ec499b9', kind: 'message', from: 'Taskboard', text: '[Taskboard event digest, 9 events]', state: 'failed', reason: 'Claude Code in #216 asks a question or shows a dialog in its terminal. Answer it there, then send again.', queued: ago(17), hook: 'it calls a tool, you send a prompt or a turn ends' };
const task = (extra: Partial<Task> = {}) => ({ id: 't216', num: 216, status: 'working', statusAt: ago(8), statusSource: '2 queued messages were given to the agent by the UserPromptSubmit hook at 5:22:01 AM.', ...extra }) as Task;

type El = ReactElement<{ children?: ReactNode; onClick?: () => void; onKeyDown?: (e: unknown) => void; className?: string; 'aria-expanded'?: boolean }>;
function all(node: ReactNode, tag: string): El[] {
  if (Array.isArray(node)) return node.flatMap(n => all(n, tag));
  if (!isValidElement(node)) return [];
  const el = node as El;
  return [...(el.type === tag ? [el] : []), ...all(el.props.children, tag)];
}
const text = (node: ReactNode): string => Array.isArray(node) ? node.map(text).join('') : isValidElement(node) ? text((node as El).props.children) : node == null || typeof node === 'boolean' ? '' : String(node);
const button = (tree: ReactNode, label: string) => {
  const b = all(tree, 'button').find(x => text(x.props.children) === label || (x.props as Record<string, unknown>)['aria-label'] === label);
  assert.ok(b, `no button "${label}" in ${renderToStaticMarkup(tree as ReactElement)}`);
  return b!;
};

test('the two Not delivered cards of the screenshot are one item with a count, most urgent first', () => {
  const list = N.taskNotices({ t: task({ queue: [failedTyping, failedDialog] }), now });
  assert.deepEqual(list.map(n => [n.kind, n.level, n.title, n.count]), [
    ['message', 'error', 'Not delivered ×2 · Message from Taskboard', 2],
    ['hook-note', 'info', 'Delivered by hook', 1],
  ]);
  // the reason line is the newest failure; the whole text has each failure with its time
  assert.match(list[0].reason, /asks a question or shows a dialog/);
  assert.match(list[0].full, /did not arrive whole[\s\S]*asks a question/);
  assert.deepEqual(list[0].ids, ['af981069', '9ec499b9']);
  // the information note hides itself and does not count
  assert.equal(list[1].autoHide, true);
  assert.equal(N.countText(N.lasting(list)), '2 notices');
});

test('order: errors, then warnings, then information; oldest first within a level', () => {
  const late: Q = { id: 'l1', kind: 'message', from: '#243', text: 'x', state: 'queued', reason: 'waits', queued: ago(40), late: true };
  const queued: Q = { id: 'q1', kind: 'message', from: '#231', text: 'y', state: 'queued', reason: 'waits', queued: ago(1) };
  const list = N.taskNotices({ t: task({ queue: [queued, late, failedDialog], status: 'stopped', stopReason: 'Usage limit.', statusAt: ago(5) }), error: 'Network down', now });
  assert.deepEqual(list.map(n => n.level), ['error', 'error', 'error', 'warn', 'info', 'info']);
  // within the errors: the failed message (17 min) before the stopped agent (5 min) and the error (now)
  assert.deepEqual(list.slice(0, 3).map(n => n.kind), ['message', 'stopped', 'error']);
  assert.equal(list[3].title, 'Not delivered after 40 min · Message from #243');
});

test('a model error of task 278 is one strip item: an error with Continue and Dismiss when stopped, information while it retries', async () => {
  const agentError = { kind: 'overloaded', text: 'API Error: 529 Overloaded', source: 'hook', at: ago(4), phase: 'stopped', since: ago(4), seen: ago(4), count: 1 } as const;
  const stopped = task({ status: 'stopped', stopReason: 'Model overloaded.', errorLabel: 'Model overloaded', agentError, autoContinueOn: false, statusSource: '' });
  const list = N.taskNotices({ t: stopped, now, autoMessage: 'go on' });
  assert.deepEqual(list.map(n => [n.kind, n.level, n.title]), [['agent-error', 'error', 'Model overloaded']], 'no second "stopped" item');
  assert.match(list[0].reason, /529 Overloaded.*Auto-continue is off for this task/);
  const sent: string[] = [];
  const orig = { send: api.send, dismiss: api.dismissAgentError };
  Object.assign(api, { send: async (_: string, text: string) => { sent.push(`send ${text}`); }, dismissAgentError: async () => { sent.push('dismiss'); } });
  try {
    const acts = noticeActions(list[0], { t: stopped, act: p => p, toast: () => {}, clearError: () => {}, clearDrop: () => {}, hide: () => {}, autoMessage: 'go on' });
    assert.deepEqual(acts.map(a => a.label), ['Continue', 'Dismiss']);
    for (const a of acts) await a.run();
    assert.deepEqual(sent, ['send go on', 'dismiss']);
  } finally { Object.assign(api, { send: orig.send, dismissAgentError: orig.dismiss }); }
  const retrying = N.taskNotices({ t: task({ status: 'working', errorLabel: 'Model overloaded', agentError: { ...agentError, phase: 'retrying' }, statusSource: '' }), now });
  assert.deepEqual(retrying.map(n => [n.kind, n.level]), [['agent-error', 'info']]);
  assert.match(retrying[0].reason, /retries by itself/);
});

test('a notice that is no longer true goes away: the delivered message, the answered question', () => {
  const pending = [{ id: 'p1', taskId: 't216', question: 'Should #261 start?', createdAt: ago(3) }] as never[];
  const before = N.taskNotices({ t: task({ queue: [failedTyping] }), pending, now });
  assert.deepEqual(before.map(n => n.kind), ['message', 'question', 'hook-note']);
  // the server closed the message (delivered or expired) and the question was answered: the next update has neither
  const after = N.taskNotices({ t: task({ queue: [] }), pending: [], now });
  assert.deepEqual(after.map(n => n.kind), ['hook-note']);
  // the strip keeps the position: the next notice moves up
  assert.equal(N.stripIndex(after, before[1].key, 1), 0);
  assert.equal(N.stripIndex(before, 'question', 0), 1, 'the same key stays in front');
});

test('information notes hide for the page and stay in the history for the LOG tab', () => {
  const list = N.taskNotices({ t: task(), now });
  const note = list[0];
  N.rememberNotice('t216', note, now);
  N.rememberNotice('t216', note, now + 1000);
  assert.equal(N.noticeHistory('t216').length, 1, 'once for each notice');
  assert.equal(N.infoHidden('t216', note.key), false);
  N.hideInfo('t216', [note.key]);
  assert.equal(N.infoHidden('t216', note.key), true);
  assert.equal(N.infoHidden('t999', note.key), false, 'for this task only');
  assert.equal(N.AUTO_HIDE_MS, 10_000);
});

test('the strip: one row with the count, Previous and Next, more, and the buttons; arrow keys and Escape', () => {
  const list = N.taskNotices({ t: task({ queue: [failedTyping, failedDialog] }), error: 'Still open in ttys004', now });
  const calls: string[] = [];
  const view = (index: number, more: boolean) => NoticeStripView({ list, index, more, id: 'nss-t216', go: d => calls.push(`go ${d}`), setMore: m => calls.push(`more ${m}`),
    actions: [{ label: 'Type again', title: '', run: () => calls.push('run') }] }) as ReactElement;
  const tree = view(0, false), html = renderToStaticMarkup(tree);
  assert.match(html, /1 of 3/);
  assert.match(html, /Not delivered ×2 · Message from Taskboard/);
  assert.doesNotMatch(html, /nss-full/, 'the whole text is folded');
  button(tree, 'Previous notice').props.onClick!();
  button(tree, 'Next notice').props.onClick!();
  button(tree, 'more').props.onClick!();
  button(tree, 'Type again').props.onClick!();
  assert.deepEqual(calls.splice(0), ['go -1', 'go 1', 'more true', 'run']);
  const key = (k: string, more = false) => { const e = { key: k, target: {}, preventDefault() {}, stopPropagation() { calls.push('stop'); } }; (view(0, more).props as { onKeyDown: (e: unknown) => void }).onKeyDown(e); };
  key('ArrowRight'); key('ArrowLeft'); key('Escape'); key('Escape', true);
  assert.deepEqual(calls, ['go 1', 'go -1', 'stop', 'more false'], 'Escape closes "more" and goes no further; without "more" it reaches the panel');
  const open = renderToStaticMarkup(view(0, true));
  assert.match(open, /id="nss-t216-full"/);
  assert.match(open, /aria-expanded="true"/);
  assert.equal(NoticeStripView({ list: [], index: 0, more: false, id: 'x', go: () => {}, setMore: () => {}, actions: [] }), null);
});

test('the buttons of a group act on each message of the group', async () => {
  const sent: string[] = [];
  const orig = api.queueAction;
  (api as Record<string, unknown>).queueAction = async (task: string, id: string, what: string) => { sent.push(`${what} ${id}`); return {}; };
  try {
    const t = task({ queue: [failedTyping, failedDialog] });
    const [n] = N.taskNotices({ t, now });
    const ctx = { t, act: (p: Promise<unknown>) => p, toast: () => {}, clearError: () => {}, clearDrop: () => {}, hide: () => {} };
    const acts = noticeActions(n, ctx);
    assert.deepEqual(acts.map(a => a.label), ['Deliver by hook', 'Type again', 'Remove']);
    assert.match(acts[0].title, /the 2 messages/);
    for (const a of acts) await a.run();
    assert.deepEqual(sent, ['hook af981069', 'hook 9ec499b9', 'retry af981069', 'retry 9ec499b9', 'remove af981069', 'remove 9ec499b9']);
    // a note: Hide only hides it in the panel and sends nothing
    const hidden: string[] = [];
    const note = N.taskNotices({ t: task(), now })[0];
    const [hide] = noticeActions(note, { ...ctx, hide: k => hidden.push(k) });
    assert.equal(hide.label, 'Hide');
    await hide.run();
    assert.deepEqual(hidden, [note.key]);
    assert.equal(sent.length, 6);
  } finally { (api as Record<string, unknown>).queueAction = orig; }
});

test('the info section: open when the task waits or has a notice, else folded; a choice per task; a default in Settings', () => {
  store.clear();
  assert.equal(N.infoDefault(), 'auto');
  assert.equal(N.infoOpen('a', { attention: true, notices: 0 }), true);
  assert.equal(N.infoOpen('a', { attention: false, notices: 2 }), true);
  assert.equal(N.infoOpen('a', { attention: false, notices: 0 }), false);
  N.setInfoOpen('a', false);
  assert.equal(N.infoOpen('a', { attention: true, notices: 2 }), false, 'the user folded this task');
  N.setInfoDefault('open');
  assert.equal(N.infoOpen('b', { attention: false, notices: 0 }), true);
  N.setInfoDefault('closed');
  assert.equal(N.infoOpen('b', { attention: true, notices: 3 }), false);
  assert.equal(N.infoOpen('a', { attention: false, notices: 0 }), false);
  // the saved choices stay at 300 tasks: the oldest go first
  for (let i = 0; i < 305; i++) N.setInfoOpen(`x${i}`, true);
  const saved = JSON.parse(store.get('tb-task-info')!);
  assert.equal(Object.keys(saved).length, 300);
  assert.equal(saved.x0, undefined);
  assert.equal(saved.x304, true);
  // broken or missing storage: the default rule still works
  store.set('tb-task-info', '[1,2'); store.delete('tb-task-info-default');
  assert.equal(N.infoOpen('c', { attention: true, notices: 0 }), true);
  const saveLs = g.localStorage;
  g.localStorage = { getItem() { throw new Error('off'); }, setItem() { throw new Error('off'); } };
  try {
    assert.equal(N.infoOpen('c', { attention: false, notices: 0 }), false);
    N.setInfoOpen('c', true); N.setInfoDefault('open');
  } finally { g.localStorage = saveLs; }
});

test('the More menu holds the seven actions of the old button rows', () => {
  const h = { moveAccount() {}, moveMachine() {}, copyAttach() {}, canvas() {}, setAside() {}, archive() {}, remove() {} };
  const base = { role: undefined, status: 'working', attach: 'tmux -L taskboard attach -t task-216' } as unknown as Task;
  assert.deepEqual(moreItems(base, h).map(m => m.label), ['Move account…', 'Move to machine…', 'Copy tmux command', 'Show on canvas', 'Set aside', 'End and archive', 'Remove…']);
  assert.match(moreItems(base, h)[2].title, /tmux -L taskboard attach -t task-216/);
  assert.deepEqual(moreItems({ ...base, role: 'controller' } as Task, h).map(m => m.label), ['Copy tmux command', 'Show on canvas', 'Set aside', 'End and archive']);
  assert.deepEqual(moreItems({ ...base, status: 'archived' } as Task, h).map(m => m.label).includes('End and archive'), false);
});

test('a long worktree path keeps its start and its end', () => {
  const p = '~/taskboard-wt/task-panel-the-info-and-notices-above-th-280';
  assert.equal(N.middleEllipsis(p, 100), p);
  const s = N.middleEllipsis(p, 40);
  assert.equal(s.length, 40);
  assert.ok(s.startsWith('~/taskboard-wt') && s.endsWith('th-280') && s.includes('…'));
});

// The rows above the terminal when the info is open: the bar (at most 40 px), the strip (one row, about 30 px), the info
// section (its own scroll), the tabs (about 33 px) and the two-line task line (about 40 px). At 900 px the info section
// gets at most 40vh - 160 px = 200 px, so the rows take at most about 350 px and the terminal keeps 60% of the panel.
test('the CSS leaves the terminal at least 60% of a 900 px panel with the info open', () => {
  const css = readFileSync('web/src/app.css', 'utf8');
  assert.match(css, /\.dr-bar \{ max-height: 40px; overflow: hidden; \}/);
  const m = css.match(/\.dr-info \{ max-height: max\((\d+)px, calc\((\d+)vh - (\d+)px\)\); overflow: auto;/);
  assert.ok(m, 'the info section has a maximum height and its own scroll');
  const info = (h: number) => Math.max(Number(m![1]), h * Number(m![2]) / 100 - Number(m![3]));
  const above = (h: number) => 40 + 30 + info(h) + 33 + 40;
  assert.ok(1 - above(900) / 900 >= 0.6, `terminal share at 900 px: ${(1 - above(900) / 900).toFixed(2)}`);
  assert.ok(1 - above(700) / 700 >= 0.55, `terminal share at 700 px: ${(1 - above(700) / 700).toFixed(2)}`);
  // folded, a task shows only the bar and the tabs; the controller only the bar
  assert.match(css, /\.dr-head\.collapsed > :not\(\.dr-bar\):not\(\.glass-pop\):not\(\.tabs\), \.dr-head\.ctl\.collapsed > \.tabs \{ display: none; \}/);
});
