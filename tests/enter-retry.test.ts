import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'tb-enter-retry-'));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
const store = await import('../server/store.ts');
const { deliverText, NotTyped } = await import('../server/deliver-text.ts');
import type { DeliverIO } from '../server/deliver-text.ts';
import type { PromptAgent } from '../server/type-command.ts';

const rule = '─'.repeat(80);
const panel = ['╭' + '─'.repeat(78) + '╮', '│ Bug report drafted', '│ clear text to review, send, or dismiss',
  '╰' + '─'.repeat(78) + '╯', '✔ Update installed · /restart to apply'];
function screen(agent: PromptAgent, text: string) {
  const mark = agent === 'codex' ? '›' : agent === 'claude' ? '❯' : '>';
  const box = `\x1b[39m${mark} ${text}`;
  return [...panel, ...(agent === 'codex' ? [box, ''] : [rule, box, rule]), '  ? for shortcuts'].join('\n');
}

let num = 0;
function fixture(agent: PromptAgent, drops: number, text = 'Message for the task') {
  const t = store.create({ id: `retry-${++num}`, num, title: 'Delivery fixture', agent, status: 'idle',
    session: `retry-${num}`, cwd: root, folder: root, desc: '' });
  const state = { now: 10_000, keyAt: 0, text: '', shown: '', enters: [] as number[], submitted: [] as string[],
    firstEnterAt: 0, captures: 0 };
  let capture: (() => string | undefined) | undefined;
  const io: DeliverIO = {
    now: () => state.now, lastKeyAt: () => state.keyAt, wait: async ms => { state.now += ms; },
    size: async () => ({ cols: 200, rows: 50, clients: 0 }), resize: async () => {},
    hold: () => () => {}, saveDraft: () => null,
    capture: async () => { state.captures++; return capture?.() ?? screen(agent, state.shown); },
    paste: async (_session, value) => {
      state.text = value;
      state.shown = agent === 'codex' ? `[Pasted Content ${value.length} chars]` : `[Pasted text #1]`;
    },
    tmux: async (...args) => {
      if (args[0] !== 'send-keys') return '';
      const key = args.at(-1);
      if (args.includes('-l')) state.text = state.shown = key!;
      else if (key === 'Enter') {
        state.enters.push(state.now);
        state.firstEnterAt ||= state.now;
        if (state.enters.length > drops) {
          state.submitted.push(state.text);
          state.text = state.shown = '';
        }
      } else if (key === 'DC' || key === 'BSpace') state.text = state.shown = '';
      return '';
    },
  };
  return { t, io, state, text, capture: (fn: typeof capture) => { capture = fn; },
    run: () => deliverText(t, text, io), log: () => store.readLog(t.id) };
}

for (const agent of ['claude', 'codex', 'antigravity'] as const) {
  for (const text of ['Message for the task', 'Long message. '.repeat(100)]) {
    test(`${agent}: two dropped Enter keys cause two logged retries and one submission (${text.length} characters)`, async () => {
      const f = fixture(agent, 2, text);
      assert.equal((await f.run()).submitted, true);
      assert.deepEqual(f.state.submitted, [text]);
      assert.equal(f.state.enters.length, 3);
      assert.ok(f.state.enters[1] - f.state.enters[0] >= 3000);
      assert.ok(f.state.enters[2] - f.state.enters[1] >= 3000);
      assert.match(f.log(), /Enter retry 1 of 2/);
      assert.match(f.log(), /Enter retry 2 of 2/);
    });
  }

  test(`${agent}: an accepted message gets no extra Enter`, async () => {
    const f = fixture(agent, 0);
    assert.equal((await f.run()).submitted, true);
    assert.deepEqual(f.state.submitted, [f.text]);
    assert.equal(f.state.enters.length, 1);
    assert.doesNotMatch(f.log(), /Enter retry/);
  });
}

test('a redraw after a dropped Enter does not count as submission', async () => {
  const f = fixture('claude', 1);
  f.capture(() => f.state.firstEnterAt && f.state.now - f.state.firstEnterAt < 1000 ? 'Drawing the terminal' : undefined);
  assert.equal((await f.run()).submitted, true);
  assert.deepEqual(f.state.submitted, [f.text]);
  assert.equal(f.state.enters.length, 2);
});

test('a hidden input box times out without another Enter or a claim of submission', async () => {
  const f = fixture('claude', 1);
  f.capture(() => f.state.firstEnterAt ? 'Drawing the terminal' : undefined);
  await assert.rejects(f.run(), /could not confirm.*submitted/);
  assert.equal(f.state.enters.length, 1);
  assert.equal(f.state.text, f.text);
  assert.deepEqual(f.state.submitted, []);
});

test('a permission question after Enter gets no further keys', async () => {
  const f = fixture('claude', 1);
  f.capture(() => f.state.firstEnterAt ? `${rule}\nDo you want to proceed?\n❯ 1. Yes\n  2. No\n${rule}` : undefined);
  await assert.rejects(f.run(), /could not confirm.*submitted/);
  assert.equal(f.state.enters.length, 1);
  assert.equal(f.state.text, f.text);
});

test('a question that leaves the message visible still prevents a retry', async () => {
  const f = fixture('codex', 1);
  f.capture(() => f.state.firstEnterAt ? `? 1 question\nShift+Left to answer\n${screen('codex', f.state.shown)}` : undefined);
  await assert.rejects(f.run(), /could not confirm.*submitted/);
  assert.equal(f.state.enters.length, 1);
});

test('a permission question in the last read before a retry gets no Enter', async () => {
  const f = fixture('claude', 1);
  let readsAtRetry = 0;
  f.capture(() => {
    if (f.state.firstEnterAt && f.state.now - f.state.firstEnterAt >= 3000 && ++readsAtRetry === 2)
      return `${rule}\nDo you want to proceed?\n❯ 1. Yes\n  2. No\n${rule}`;
    return undefined;
  });
  await assert.rejects(f.run(), /could not confirm.*submitted/);
  assert.equal(f.state.enters.length, 1);
  assert.equal(f.state.text, '', 'the question disappears on the next capture, so cleanup removes the message');
});

test('submission in the last read before a retry gets no extra Enter', async () => {
  const f = fixture('claude', 1);
  let readsAtRetry = 0;
  f.capture(() => {
    if (f.state.firstEnterAt && f.state.now - f.state.firstEnterAt >= 3000 && ++readsAtRetry === 2) {
      f.state.submitted.push(f.state.text);
      f.state.text = f.state.shown = '';
    }
    return undefined;
  });
  assert.equal((await f.run()).submitted, true);
  assert.deepEqual(f.state.submitted, [f.text]);
  assert.equal(f.state.enters.length, 1);
});

test('a changed draft is neither submitted nor cleared', async () => {
  const f = fixture('claude', 1);
  f.capture(() => f.state.firstEnterAt ? screen('claude', f.text + ' changed') : undefined);
  await assert.rejects(f.run(), /could not confirm.*submitted/);
  assert.equal(f.state.enters.length, 1);
  assert.equal(f.state.text, f.text);
});

test('a different Claude paste placeholder is not submitted', async () => {
  const f = fixture('claude', 1, 'Long message. '.repeat(100));
  f.capture(() => f.state.firstEnterAt ? screen('claude', '[Pasted text #2]') : undefined);
  await assert.rejects(f.run(), /could not confirm.*submitted/);
  assert.equal(f.state.enters.length, 1);
});

test('dashboard typing after Enter prevents retries even when the box looks unchanged', async () => {
  const f = fixture('claude', 1);
  f.capture(() => { if (f.state.firstEnterAt) f.state.keyAt = f.state.now; return undefined; });
  await assert.rejects(f.run(), /could not confirm.*submitted/);
  assert.equal(f.state.enters.length, 1);
  assert.equal(f.state.text, f.text);
});

test('a delayed submission before the retry gets no extra Enter', async () => {
  const f = fixture('claude', 1);
  f.capture(() => {
    if (f.state.firstEnterAt && f.state.now - f.state.firstEnterAt >= 2750) {
      f.state.submitted.push(f.state.text);
      f.state.text = f.state.shown = '';
    }
    return undefined;
  });
  assert.equal((await f.run()).submitted, true);
  assert.deepEqual(f.state.submitted, [f.text]);
  assert.equal(f.state.enters.length, 1);
});

test('Enter retries stop at two and the unchanged message returns to the queue', async () => {
  const f = fixture('claude', Infinity);
  await assert.rejects(f.run(), e => e instanceof NotTyped && e.state === 'retry');
  assert.equal(f.state.enters.length, 3);
  assert.equal(f.state.text, '');
  assert.deepEqual(f.state.submitted, []);
  assert.equal((f.log().match(/Enter retry/g) || []).length, 2);
});

test('a redraw cannot cause cleanup less than three seconds after an Enter retry', async () => {
  const f = fixture('claude', Infinity);
  f.capture(() => f.state.firstEnterAt && f.state.now - f.state.firstEnterAt < 1000 ? 'Drawing the terminal' : undefined);
  await assert.rejects(f.run(), e => e instanceof NotTyped && e.state === 'retry');
  assert.equal(f.state.enters.length, 2);
  assert.ok(f.state.now - f.state.enters.at(-1)! >= 3000);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
