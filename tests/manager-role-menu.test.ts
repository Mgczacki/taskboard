import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

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
const { ManagerRoleView, doneText } = await import('../web/src/components/ManagerBoard.tsx');
const { NO_GROUP_HINT, groupManager, managerGroupsOf, managerMenu, scopeOf, setManager, setManagerGroups } = await import('../web/src/managerBoard.ts');
type Scope = NonNullable<ReturnType<typeof scopeOf>>;
type Menu = Exclude<ReturnType<typeof managerMenu>, { hidden: true }>;
type Choice = Menu['choices'][number];

// The manager item of a task menu (task 276). This repo has no DOM test runner: the tests call the hook-free view
// ManagerRoleView, find its <button> and <select> elements in the returned tree and call their handlers.

const task = (id: string, num: number, status = 'idle', role?: string) => ({ id, num, title: 'Task ' + num, status, role });
const group = (id: string, name: string, tasks: string[], manager?: string) => ({ id, name, color: '#888', tasks, created: '', manager });
const t1 = task('t1', 1), t2 = task('t2', 2), t3 = task('t3', 3);
const tasks = [t1, t2, t3];
const scope = (preset: Scope['preset'] = null): Scope => ({
  group: { id: 'g1', name: 'Alpha', tasks: ['t1', 't2'] }, caps: { newPerDay: 8 }, actions: [], preset, defaultPreset: 'direct',
  presets: {
    watch: { name: 'Watch only', may: ['Read the board'], not: ['Send messages'] },
    direct: { name: 'Direct the group', may: ['Everything in Watch only', 'Send up to 30 messages'], not: ['Start new tasks'] },
    create: { name: 'Direct and create tasks', may: ['Start up to 8 new tasks a day'], not: [] },
  },
  never: ['Approve a card'], rule: 'Group managers: rule.', ruleLimits: 'Limits.',
});

type El = ReactElement<{ children?: ReactNode; onClick?: () => void; onChange?: (e: { target: { value: string } }) => void; disabled?: boolean; autoFocus?: boolean; className?: string; type?: string; onKeyDown?: unknown; 'aria-disabled'?: string; value?: string }>;
function all(node: ReactNode, tag: string): El[] {
  if (Array.isArray(node)) return node.flatMap(n => all(n, tag));
  if (!isValidElement(node)) return [];
  const el = node as El;
  return [...(el.type === tag ? [el] : []), ...all(el.props.children, tag)];
}
const text = (node: ReactNode): string => Array.isArray(node) ? node.map(text).join('') : isValidElement(node) ? text((node as El).props.children) : node == null || typeof node === 'boolean' ? '' : String(node);
const button = (tree: ReactNode, label: string) => {
  const b = all(tree, 'button').find(x => text(x.props.children).includes(label));
  assert.ok(b, `no button "${label}" in ${renderToStaticMarkup(tree as ReactElement)}`);
  return b!;
};

function view(menu: Menu, step: Choice | null, opts: { scope?: Scope; preset?: Scope['defaultPreset']; busy?: boolean; error?: string } = {}) {
  const calls: string[] = [];
  const tree = ManagerRoleView({ t: t1, menu, step, scope: 'scope' in opts ? opts.scope : scope(), preset: opts.preset || 'direct', busy: !!opts.busy, error: opts.error || '',
    pick: c => calls.push('pick ' + c.label), setPreset: p => calls.push('preset ' + p), confirm: () => calls.push('confirm'), cancel: () => calls.push('cancel') });
  return { tree, calls, html: renderToStaticMarkup(tree) };
}
const menuOf = (t: ReturnType<typeof task>, groups: ReturnType<typeof group>[]) => {
  setManagerGroups(groups);
  return managerMenu(t, groups, tasks);
};

test('a task in exactly one group without a manager gets "Make manager of <group>"', () => {
  const m = menuOf(t1, [group('g1', 'Alpha', ['t1', 't2'])]) as Menu;
  assert.equal(m.label, 'Make manager of Alpha');
  assert.deepEqual(m.choices.map(c => [c.kind, c.label, c.disabled]), [['make', 'Make manager of Alpha', undefined]]);
});

test('a task in several groups gets a list of its groups', () => {
  const m = menuOf(t1, [group('g1', 'Alpha', ['t1']), group('g2', 'Beta', ['t1', 't3']), group('g3', 'Other', ['t2'])]) as Menu;
  assert.equal(m.label, 'Make manager of…');
  assert.deepEqual(m.choices.map(c => c.label), ['Make manager of Alpha', 'Make manager of Beta']);
  const { tree, calls, html } = view(m, null);
  assert.match(html, /Make manager of Alpha/);
  assert.match(html, /Make manager of Beta/);
  button(tree, 'Make manager of Beta').props.onClick!();
  assert.deepEqual(calls, ['pick Make manager of Beta']);
});

test('a task in no group gets a greyed item with the hint', () => {
  const m = menuOf(t3, [group('g1', 'Alpha', ['t1'])]) as Menu;
  assert.deepEqual(m.choices, []);
  assert.equal(m.hint, NO_GROUP_HINT);
  assert.match(NO_GROUP_HINT, /^Add this task to a group first\./);
  const { tree, calls, html } = view(m, null);
  const b = button(tree, 'Make manager');
  assert.equal(b.props['aria-disabled'], 'true');
  assert.match(b.props.className || '', /\boff\b/);
  b.props.onClick?.();
  assert.deepEqual(calls, []);
  assert.match(html, /Add this task to a group first/);
});

test('the manager of a group gets "Stop managing" and "Change preset"', () => {
  const m = menuOf(t1, [group('g1', 'Alpha', ['t1', 't2'], 't1')]) as Menu;
  assert.equal(m.label, 'Manager role');
  assert.deepEqual(m.choices.map(c => [c.kind, c.label]), [['stop', 'Stop managing Alpha'], ['preset', 'Change preset of Alpha']]);
  // with one preset only, there is nothing to change
  setManagerGroups([group('g1', 'Alpha', ['t1'], 't1')]);
  assert.deepEqual((managerMenu(t1, [group('g1', 'Alpha', ['t1'], 't1')], tasks, 1) as Menu).choices.map(c => c.kind), ['stop']);
});

test('a group with another manager gets "Replace <manager> as manager" with a confirm step', () => {
  const m = menuOf(t1, [group('g1', 'Alpha', ['t1', 't2'], 't2')]) as Menu;
  assert.equal(m.label, 'Replace #2 as manager of Alpha');
  const c = m.choices[0];
  assert.equal(c.kind, 'replace');
  assert.deepEqual(c.current, { id: 't2', num: 2, title: 'Task 2' });
  const { tree, calls, html } = view(m, c);
  assert.match(html, /Replace #2 as manager of Alpha\?/);
  assert.match(html, /#2 \(Task 2\) stops managing Alpha\. #1 takes the role\./);
  button(tree, 'Replace manager').props.onClick!();
  assert.deepEqual(calls, ['confirm']);
});

test('the controller gets no manager item', () => {
  assert.deepEqual(menuOf(task('controller', 0, 'idle', 'controller'), [group('g1', 'Alpha', ['controller'])]), { hidden: true });
  assert.deepEqual(menuOf(task('c9', 9, 'idle', 'controller'), [group('g1', 'Alpha', ['c9'])]), { hidden: true });
});

test('an archived or set-aside task gets a greyed item with the reason, and a manager can still stop', () => {
  const arch = menuOf(task('t1', 1, 'archived'), [group('g1', 'Alpha', ['t1'])]) as Menu;
  assert.match(arch.choices[0].disabled || '', /^Restore this task first\./);
  const parked = menuOf(task('t1', 1, 'parked'), [group('g1', 'Alpha', ['t1']), group('g2', 'Beta', ['t1'], 't2')]) as Menu;
  assert.deepEqual(parked.choices.map(c => [c.kind, !!c.disabled]), [['make', true], ['replace', true]]);
  assert.match(parked.choices[0].disabled || '', /^Bring this task back first\./);
  const { tree, calls, html } = view(parked, null);
  for (const b of all(tree, 'button')) { assert.equal(b.props['aria-disabled'], 'true'); b.props.onClick?.(); }
  assert.deepEqual(calls, []);
  assert.match(html, /Bring this task back first/);
  // an archived task that still holds the role may give it up, but not change the preset
  const mgr = menuOf(task('t1', 1, 'archived'), [group('g1', 'Alpha', ['t1'], 't1')]) as Menu;
  assert.deepEqual(mgr.choices.map(c => [c.kind, !!c.disabled]), [['stop', false]]);
});

test('the confirm panel shows the preset text, a Preset drop-down, Make manager and Cancel', () => {
  const m = menuOf(t1, [group('g1', 'Alpha', ['t1'])]) as Menu;
  const { tree, calls, html } = view(m, m.choices[0]);
  assert.match(html, /Make #1 manager of Alpha\?/);
  assert.match(html, /Without a card, #1 may:/);
  assert.match(html, /Send up to 30 messages/);
  assert.match(html, /Only with your card:.*Start new tasks/);
  assert.match(html, /Never:.*Approve a card/);
  const [sel] = all(tree, 'select');
  assert.equal(sel.props.value, 'direct');
  assert.match(renderToStaticMarkup(sel), /Direct the group \(default\)/);
  sel.props.onChange!({ target: { value: 'watch' } });
  button(tree, 'Make manager').props.onClick!();
  button(tree, 'Cancel').props.onClick!();
  assert.deepEqual(calls, ['preset watch', 'confirm', 'cancel']);
  // while the presets load, and while the call runs, the main button waits
  assert.equal(button(view(m, m.choices[0], { scope: undefined }).tree, 'Make manager').props.disabled, true);
  assert.match(view(m, m.choices[0], { scope: undefined }).html, /Loading the presets/);
  assert.equal(button(view(m, m.choices[0], { busy: true }).tree, 'Saving').props.disabled, true);
  assert.match(view(m, m.choices[0], { error: 'Choose a live task in this group.' }).html, /role="alert">Choose a live task in this group\./);
});

test('Stop managing needs one confirm click and says what ends', () => {
  const m = menuOf(t1, [group('g1', 'Alpha', ['t1', 't2'], 't1')]) as Menu;
  const { tree, calls, html } = view(m, m.choices[0]);
  assert.match(html, /Stop managing Alpha\?/);
  assert.match(html, /The tasks of Alpha no longer message #1 without a card\./);
  assert.equal(all(tree, 'select').length, 0);
  button(tree, 'Stop managing').props.onClick!();
  assert.deepEqual(calls, ['confirm']);
  // Change preset: the button waits until the preset differs from the current one
  const same = view(m, m.choices[1], { scope: scope('direct'), preset: 'direct' });
  assert.equal(button(same.tree, 'Change preset').props.disabled, true);
  assert.equal(button(view(m, m.choices[1], { scope: scope('direct'), preset: 'create' }).tree, 'Change preset').props.disabled, false);
});

test('keyboard: native buttons, focus on the first control of the confirm panel', () => {
  const m = menuOf(t1, [group('g1', 'Alpha', ['t1', 't2'], 't1')]) as Menu;
  for (const step of [null, ...m.choices]) for (const b of all(view(m, step).tree, 'button')) {
    // a <button> without a type and without a key handler clicks on Enter and on Space
    assert.equal(b.props.type, undefined);
    assert.equal(b.props.onKeyDown, undefined);
  }
  const stop = view(m, m.choices[0]).tree;
  assert.equal(button(stop, 'Cancel').props.autoFocus, true);
  const make = menuOf(t1, [group('g1', 'Alpha', ['t1'])]) as Menu;
  assert.equal(all(view(make, make.choices[0]).tree, 'select')[0].props.autoFocus, true);
  // PopMenu moves the focus with the arrow keys and closes on Escape
  const pop = readFileSync(new URL('../web/src/components/PopMenu.tsx', import.meta.url), 'utf8');
  assert.match(pop, /e\.key === 'Escape'/);
  assert.match(pop, /ArrowDown/);
});

test('setManager posts to /api/manager/<group>, then the badge and the group tab change at once', async () => {
  setManagerGroups([group('g1', 'Alpha', ['t1', 't2'])]);
  const posts: [string, unknown][] = [];
  const gets: string[] = [];
  const post = async (url: string, body: unknown) => { posts.push([url, body]); return { ok: true, json: async () => ({}) }; };
  const get = async (url: string) => { gets.push(url); return { json: async () => url.startsWith('/api/manager/') ? { ...scope('direct'), group: { id: 'g1', name: 'Alpha', tasks: ['t1', 't2'], manager: 't1' } } : [] }; };
  await setManager('g1', { task: 't1', preset: 'direct' }, post, get);
  assert.deepEqual(posts, [['/api/manager/g1', { task: 't1', preset: 'direct' }]]);
  assert.equal(groupManager({ id: 'g1' }), 't1');
  assert.deepEqual(managerGroupsOf('t1').map(x => x.id), ['g1']);
  // the group menu reads the same scope
  assert.equal(scopeOf('g1')?.group.manager, 't1');
  assert.ok(gets.includes('/api/manager/g1'));
  await setManager('g1', { task: null }, post, get);
  assert.equal(groupManager({ id: 'g1', manager: 't1' }), undefined);
  assert.deepEqual(managerGroupsOf('t1'), []);
});

test('a refusal of the server shows its text and changes nothing', async () => {
  setManagerGroups([group('g1', 'Alpha', ['t1'])]);
  const post = async () => ({ ok: false, json: async () => ({ error: 'Choose a live task in this group. The controller cannot manage a group.' }) });
  await assert.rejects(setManager('g1', { task: 'controller' }, post, async () => ({ json: async () => ({}) })), /The controller cannot manage a group/);
  assert.equal(groupManager({ id: 'g1' }), undefined);
});

test('the toast names the task, the group and the preset', () => {
  const grp = { id: 'g1', name: 'Alpha' };
  assert.equal(doneText(t1, { kind: 'make', group: grp, label: '' }, 'Direct the group'), '#1 now manages Alpha with the preset Direct the group.');
  assert.equal(doneText(t1, { kind: 'replace', group: grp, current: { id: 't2', num: 2 }, label: '' }, 'Watch only'), '#1 now manages Alpha in place of #2, with the preset Watch only.');
  assert.equal(doneText(t1, { kind: 'stop', group: grp, label: '' }, ''), '#1 no longer manages Alpha.');
});

test('the canvas header, its narrow menu and the task panel show the item, and the group menu keeps its control', () => {
  const canvas = readFileSync(new URL('../web/src/components/Canvas.tsx', import.meta.url), 'utf8');
  assert.match(canvas, /<ManagerRoleButton t=\{t\} variant="head"/);
  assert.match(canvas, /<ManagerRoleButton t=\{t\} variant="menu"/);
  assert.match(canvas, /<ManagerScope group=\{g\.id\} tasks=\{tasks\} \/>/);
  assert.match(readFileSync(new URL('../web/src/components/TaskPanel.tsx', import.meta.url), 'utf8'), /<ManagerRoleButton t=\{t\} variant="button"/);
});
