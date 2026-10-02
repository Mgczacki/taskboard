import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pending from '../server/pending.ts';
import type { Task } from '../server/store.ts';

const W = '─'.repeat(80), D = '╌'.repeat(80);
const permission = (cmd: string, sel = 0) => [W, ' Bash command', ' Run it', D, ` ${cmd}`, D, ' Do you want to proceed?',
  ...['1. Yes', '2. Yes, and always allow access to /x from this project', '3. No'].map((o, i) => (i === sel ? ' ❯ ' : '   ') + o),
  ' Esc to cancel · Tab to amend'].join('\n');
const codexUpdate = (sel: number) => ['  ✨ Update available! 0.158.0 -> 0.160.0', '', ...['1. Update now (runs `curl | sh`)', '2. Skip', '3. Skip until next version'].map((o, i) => (i === sel ? '› ' : '  ') + o), '', '  Press enter to continue'].join('\n');

const tasks = new Map<string, Task>();
const task = (id: string, num: number, agent: Task['agent'] = 'claude', extra: Partial<Task> = {}) => {
  const t = { id, num, title: `Task ${num}`, agent, session: `s-${id}`, status: 'needs-you', cwd: '/tmp', ...extra } as Task;
  tasks.set(id, t); return t;
};
const screens = new Map<string, string>();
const keys: [string, string][] = [];
const logs: string[] = [];
pending.setIo({
  capture: async s => screens.get(s) || '',
  key: async (s, k) => {
    keys.push([s, k]);
    // a fake Codex list: arrows move the highlight, Enter or a digit closes the dialog
    const cur = screens.get(s) || '';
    if (/Update available/.test(cur)) {
      const sel = cur.split('\n').filter(r => /^\s*[›\s] ?\d\./.test(r)).findIndex(r => r.startsWith('›'));
      if (k === 'Down') screens.set(s, codexUpdate(Math.min(2, sel + 1)));
      else if (k === 'Up') screens.set(s, codexUpdate(Math.max(0, sel - 1)));
      else screens.set(s, '› ');
    } else screens.set(s, '› ');
  },
  cancelCopyMode: async () => {},
  sendText: async () => ({ submitted: true }),
  getTask: id => tasks.get(id),
  log: (t, did) => logs.push(`#${t.num} ${did}`),
  answered: () => {},
  wait: async () => {},
});
const itemFor = (taskId: string) => pending.list().find(i => i.taskId === taskId)!;

test('a held Claude Code permission hook returns the decision of the click', async () => {
  const t = task('a', 1);
  let ended = () => {};
  const out = pending.holdClaude(t, { tool_name: 'Bash', tool_input: { command: 'ls', description: 'List files' }, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow', destination: 'localSettings' }] }, fn => { ended = fn; }, 60_000);
  const item = itemFor('a');
  assert.equal(item.kind, 'command');
  assert.deepEqual(item.options.map(o => o.key), ['once', 'always', 'no']);
  assert.equal(item.options[1].risk, 'wide-access');
  await assert.rejects(pending.answer(item.id, { option: 'always', by: 'user' }), /confirm step/);
  await pending.answer(item.id, { option: 'no', text: 'Use rg instead.', by: 'user' });
  assert.deepEqual(await out, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Use rg instead.' } } });
  assert.match(logs.pop()!, /^#1 The user answered "Bash command: List files" with "3. No"/);
  ended();
  assert.equal(pending.get(item.id)!.state, 'answered');
});

test('the hook ends first (answered in the terminal): the card closes, the request gets no decision', async () => {
  const t = task('b', 2);
  let ended = () => {};
  const out = pending.holdClaude(t, { tool_name: 'Bash', tool_input: { command: 'ls' } }, fn => { ended = fn; }, 60_000);
  const id = itemFor('b').id;
  ended();
  assert.equal(await out, undefined);
  assert.equal(pending.get(id)!.state, 'gone');
  await assert.rejects(pending.answer(id, { option: 'once', by: 'user' }), /closed/);
});

test('AskUserQuestion: one question gives option buttons and a text answer', async () => {
  const t = task('c', 3);
  const q = { question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }], multiSelect: false };
  const out = pending.holdClaude(t, { tool_name: 'AskUserQuestion', tool_input: { questions: [q] } }, () => {}, 60_000);
  const item = itemFor('c');
  assert.equal(item.kind, 'choice');
  await pending.answer(item.id, { text: 'Green', by: 'user' });
  assert.deepEqual((await out as any).hookSpecificOutput.decision, { behavior: 'allow', updatedInput: { questions: [q], answers: { 'Which color?': 'Green' } } });
});

test('a screen prompt is answered with its digit after a screen check, and refused when the screen changed', async () => {
  const t = task('d', 4);
  screens.set(t.session, permission('touch out/a.txt'));
  pending.scan(t, screens.get(t.session)!);
  const item = itemFor('d');
  assert.equal(item.source, 'screen');
  assert.equal(item.details?.command, 'touch out/a.txt');
  screens.set(t.session, permission('touch out/OTHER.txt'));
  await assert.rejects(pending.answer(item.id, { option: 'o0', by: 'user' }), /not the one on this card/);
  assert.equal(keys.filter(k => k[0] === t.session).length, 0);
  screens.set(t.session, permission('touch out/a.txt'));
  const done = await pending.answer(item.id, { option: 'o0', by: 'user' });
  assert.equal(done.state, 'answered');
  assert.deepEqual(keys.filter(k => k[0] === t.session), [[t.session, '1']]);
});

test('arrow keys: the highlight moves and is checked before Enter', async () => {
  const t = task('e', 5, 'codex');
  screens.set(t.session, codexUpdate(0));
  pending.scan(t, screens.get(t.session)!);
  const item = itemFor('e');
  assert.equal(item.options[0].risk, 'installs');
  await pending.answer(item.id, { option: 'o2', by: 'user' });
  assert.deepEqual(keys.filter(k => k[0] === t.session).map(k => k[1]), ['Down', 'Down', 'Enter']);
});

test('a prompt gone from the screen closes its card; a question at the end of a turn is typed as a prompt', async () => {
  const t = task('f', 6);
  screens.set(t.session, permission('ls'));
  pending.scan(t, screens.get(t.session)!);
  const id = itemFor('f').id;
  pending.scan(t, '❯ ');
  assert.equal(pending.get(id)!.state, 'gone');
  const t2 = task('g', 7, 'codex', { ask: 'Did you mean a status update?', statusSource: 'Codex notify (agent-turn-complete) at 09:00.' });
  pending.scan(t2, '› ');
  const q = itemFor('g');
  assert.equal(q.kind, 'text');
  await pending.answer(q.id, { text: 'Yes, a status update.', by: 'user' });
  assert.equal(pending.get(q.id)!.state, 'answered');
});

test('one click for several tasks only for the listed tasks with the same prompt', async () => {
  const a = task('h', 8), b = task('i', 9), c = task('j', 10);
  for (const t of [a, b]) { screens.set(t.session, permission('pnpm install')); pending.scan(t, screens.get(t.session)!); }
  screens.set(c.session, permission('pnpm test')); pending.scan(c, screens.get(c.session)!);
  const ia = itemFor('h');
  assert.deepEqual(ia.sameIn?.map(s => s.taskNum), [9]);
  await assert.rejects(pending.answer(ia.id, { option: 'o0', group: [itemFor('j').id], by: 'user' }), /no longer waits on the same prompt/);
  const r = await pending.answer(ia.id, { option: 'o0', group: [itemFor('i').id], by: 'user' });
  assert.deepEqual(r.answer?.tasks, [8, 9]);
  assert.equal(pending.list().some(i => i.taskId === 'i'), false);
});

test('controller rules', () => {
  const base = { id: 'x1', taskId: 'z', taskNum: 1, taskTitle: '', agent: 'claude', source: 'screen', question: 'q', answerable: true, createdAt: '', state: 'pending' } as const;
  const cmd = { ...base, kind: 'command', details: { command: 'ls -la' }, options: [{ key: 'once', label: 'Yes', send: '' }, { key: 'always', label: 'Always', send: '', risk: 'wide-access' }, { key: 'no', label: 'No', send: '', deny: true }] } as pending.PendingItem;
  assert.throws(() => pending.controllerRule(cmd, { option: 'always' }, { ok: true }, true), /cannot choose/);
  assert.throws(() => pending.controllerRule(cmd, { option: 'once', group: ['y'] }, { ok: true }, true), /one card at a time/);
  assert.equal(pending.controllerRule(cmd, { option: 'once' }, { ok: false }, true), 'low-risk command');
  assert.throws(() => pending.controllerRule(cmd, { option: 'once' }, { ok: false }, false), /user's own words/);
  assert.throws(() => pending.controllerRule({ ...cmd, details: { command: 'rm -rf x' } }, { option: 'once' }, { ok: false }, true), /user's own words/);
  assert.equal(pending.controllerRule({ ...cmd, details: { command: 'rm -rf x' } }, { option: 'once' }, { ok: true }, false), 'explicit user request');
  assert.throws(() => pending.controllerRule({ ...cmd, kind: 'dialog', name: 'claude-trust' }, { option: 'once' }, { ok: true }, true), /trust/);
});

test('a held hook is released when its tool ran (the user said Yes in the terminal) or the turn moved on', async () => {
  const t = task('k', 11);
  const a = pending.holdClaude(t, { tool_name: 'Bash', tool_input: { command: 'ls' } }, () => {}, 60_000);
  const b = pending.holdClaude(t, { tool_name: 'Edit', tool_input: { file_path: '/x' } }, () => {}, 60_000);
  pending.releaseClaude('k', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.equal(await a, undefined);
  assert.equal(pending.list().filter(i => i.taskId === 'k').length, 1);
  pending.releaseClaude('k');
  assert.equal(await b, undefined);
  assert.equal(pending.list().filter(i => i.taskId === 'k').length, 0);
});
