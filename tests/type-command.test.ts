import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'tb-type-command-'));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-type-command-${process.pid}`;
const { commandError, inputBox, readyForInput, showsCommand, typeCommand } = await import('../server/type-command.ts');
type Task = Parameters<typeof typeCommand>[0];

const RULE = '─'.repeat(60);
// Claude Code's screen: output, then its input box between two rules, then the hint row
const screen = (...box: string[]) => ['⏺ Please run ! gcloud auth login', '', RULE, ...box, RULE, '  ? for shortcuts'].join('\n');

test('reads the input box between the last two rules', () => {
  assert.equal(inputBox(screen('❯ ')), '❯');
  assert.equal(inputBox(screen('! gcloud auth application-default login --project', '  my-project')), '! gcloud auth application-default login --project\nmy-project');
  assert.equal(inputBox('no box here'), null);
});

test('is ready only for an empty prompt with no question on the screen', () => {
  assert.equal(readyForInput(screen('❯ ')), true);
  assert.equal(readyForInput(screen('❯ Try "fix the lint errors"')), true, 'a grey suggestion is not text');
  assert.equal(readyForInput(screen('! ')), false, 'already in shell mode');
  assert.equal(readyForInput(['Allow this action?', '❯ 1. Yes', '  2. No'].join('\n')), false);
  assert.equal(readyForInput(screen('❯ ') + '\nApprove this tool'), false);
  assert.equal(readyForInput([RULE, ' Bash command', '   rm -rf build', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', RULE].join('\n')), false);
  assert.equal(readyForInput(screen('❯ first line of a draft', '  second line')), false, 'a draft with two rows');
});

test('accepts the typed text only when the box holds just this command', () => {
  assert.equal(showsCommand(screen('! gcloud auth login'), 'gcloud auth login'), true);
  assert.equal(showsCommand(screen('! gcloud auth application-default login --project', '  my-project'), 'gcloud auth application-default login --project my-project'), true);
  assert.equal(showsCommand(screen('❯ draft text! gcloud auth login'), 'gcloud auth login'), false);
  assert.equal(showsCommand(screen('! gcloud auth login extra'), 'gcloud auth login'), false);
});

test('refuses empty, long or hidden-character commands', () => {
  assert.equal(commandError('gh auth status'), null);
  assert.ok(commandError(''));
  assert.ok(commandError(42));
  assert.ok(commandError('ls\nrm -rf ~'));
  assert.ok(commandError('ls \u202e txt'));
  assert.ok(commandError('x'.repeat(1001)));
});

// A tmux stand-in: it records keys and answers captures from a list of screens.
function fakeTmux(screens: string[], mode = '') {
  const keys: string[][] = [];
  let i = 0;
  return {
    keys,
    io: {
      tmux: async (...args: string[]) => { if (args[0] === 'display-message') return mode + '\n'; keys.push(args); return ''; },
      capture: async () => screens[Math.min(i++, screens.length - 1)],
      wait: async () => {},
    },
  };
}
const task = { id: 't-1', num: 7, agent: 'claude', status: 'working', session: 'task-7' } as Task;
const sent = (keys: string[][]) => keys.map(k => k.slice(k.indexOf('-t') + 2).join(' '));

test('types the command, then presses Enter once the box shows it', async () => {
  const t = fakeTmux([screen('❯ '), screen('❯ '), screen('! gh auth status')]);
  const r = await typeCommand(task, 'gh auth status', t.io);
  assert.equal(r.ran, true);
  assert.deepEqual(sent(t.keys), ['-l !gh auth status', 'Enter']);
});

test('does not press Enter when the box shows other text, for example a draft', async () => {
  const t = fakeTmux([screen('❯ '), screen('❯ draft! gh auth status')]);
  const r = await typeCommand(task, 'gh auth status', t.io);
  assert.equal(r.ran, false);
  assert.deepEqual(sent(t.keys), ['-l !gh auth status'], 'no Enter');
});

test('types nothing while Claude Code asks a question', async () => {
  const asking = fakeTmux(['Allow this action?\n❯ 1. Yes\n  2. No']);
  await assert.rejects(typeCommand(task, 'gh auth status', asking.io), /Nothing was typed/);
  assert.deepEqual(asking.keys, []);
});

// Codex 0.158.0: no rules. The prompt row starts with "›", a blank row and the footer follow.
const FOOTER = ['', '  GPT-6-Sol medium · ~/project', '                         ← for agents · ? for shortcuts'];
const codexScreen = (...box: string[]) => ['› Run the tests', '', '• Please run ! gh auth status now.', '', ...box, ...FOOTER].join('\n');
// Antigravity CLI 1.2.14: rules like Claude Code, with ">" as the prompt mark.
const agyScreen = (...box: string[]) => ['  Please run ! gh auth status now.', RULE, ...box, RULE, '? for shortcuts      Claude Sonnet 4.6 (Thinking)'].join('\n');

test('reads the Codex prompt, and not an earlier user message shown with the same mark', () => {
  assert.equal(inputBox(codexScreen('› Ask Codex to do anything'), 'codex'), '› Ask Codex to do anything');
  assert.equal(inputBox(codexScreen('! echo aaaa', '  bbbb cccc'), 'codex'), '! echo aaaa\nbbbb cccc');
  assert.equal(readyForInput(codexScreen('› Ask Codex to do anything'), 'codex'), true);
  assert.equal(readyForInput(codexScreen('!'), 'codex'), false, 'already in shell mode');
  assert.equal(showsCommand(codexScreen('! gh auth status'), 'gh auth status', 'codex'), true);
  assert.equal(showsCommand(codexScreen('› my draft!gh auth status'), 'gh auth status', 'codex'), false);
  // a question fills the bottom of the screen: the last "›" row is an earlier message with more text below it
  const question = ['› Run the tests', '', '• Ran tests', '  Would you like to run the following command?', '  $ rm -rf build', '› 1. Yes, proceed (y)', '  2. No (esc)', '', '  Press enter to confirm'].join('\n');
  assert.equal(readyForInput(question, 'codex'), false);
  assert.equal(readyForInput(['› Run the tests', '', '• Working', '  more output', '  more output', '  more output', '  more output', '  more output'].join('\n'), 'codex'), false);
});

test('reads the Antigravity prompt and its permission question', () => {
  assert.equal(readyForInput(agyScreen('>'), 'antigravity'), true);
  assert.equal(readyForInput(agyScreen('❯ '), 'antigravity'), false, 'the Claude Code mark is not the Antigravity mark');
  assert.equal(showsCommand(agyScreen('! gh auth status'), 'gh auth status', 'antigravity'), true);
  assert.equal(showsCommand(agyScreen('> my draft!gh auth status'), 'gh auth status', 'antigravity'), false);
  const permission = [RULE, '> Run this', RULE, '● Bash(touch a.txt)', 'Command', RULE, 'Requesting permission for:', '   touch a.txt', 'Run this command?', '> 1. Yes, run command', '  4. No, cancel', 'esc to cancel'].join('\n');
  assert.equal(readyForInput(permission, 'antigravity'), false);
});

test('types into Codex and Antigravity tasks the same way', async () => {
  const codex = fakeTmux([codexScreen('› Ask Codex to do anything'), codexScreen('! gh auth status')]);
  assert.equal((await typeCommand({ ...task, agent: 'codex' } as Task, 'gh auth status', codex.io)).ran, true);
  assert.deepEqual(sent(codex.keys), ['-l !gh auth status', 'Enter']);
  const agy = fakeTmux([agyScreen('>'), agyScreen('! gh auth status')]);
  assert.equal((await typeCommand({ ...task, agent: 'antigravity' } as Task, 'gh auth status', agy.io)).ran, true);
  assert.deepEqual(sent(agy.keys), ['-l !gh auth status', 'Enter']);
});

test('leaves tmux copy mode before it types', async () => {
  const t = fakeTmux([screen('❯ '), screen('! ls')], 'copy-mode');
  await typeCommand(task, 'ls', t.io);
  assert.deepEqual(t.keys[0], ['send-keys', '-X', '-t', '=task-7:', 'cancel']);
});
