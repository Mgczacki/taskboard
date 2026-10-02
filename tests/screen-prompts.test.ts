import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrompt, riskOf } from '../server/screen-prompts.ts';

// Screens captured on 2026-10-02 (Claude Code 2.1.287, Codex 0.160.0, Antigravity 1.2.14), folders shortened.
const W = '─'.repeat(80), D = '╌'.repeat(80);
const claudePermission = [
  '❯ Run this exact bash command and nothing else: touch out/b.txt',
  '⏺ Creating file out/b.txt',
  '  ⎿  $ touch out/b.txt',
  W,
  ' Bash command',
  ' Create file out/b.txt',
  D,
  ' touch out/b.txt',
  D,
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and always allow access to /private/tmp/scratch/cc/out from this project',
  '   3. No',
  ' Esc to cancel · Tab to amend',
].join('\n');

test('Claude Code permission dialog: command, digits, and a risky "always allow"', () => {
  const p = parsePrompt('claude', claudePermission)!;
  assert.equal(p.name, 'claude-permission');
  assert.equal(p.kind, 'command');
  assert.equal(p.question, 'Do you want to proceed?');
  assert.equal(p.details.command, 'touch out/b.txt');
  assert.equal(p.details.title, 'Bash command · Create file out/b.txt');
  assert.deepEqual(p.options.map(o => o.key), ['1', '2', '3']);
  assert.equal(p.options[1].risk, 'wide-access');
  assert.equal(p.options[0].risk, undefined);
  assert.equal(p.selected, 0);
  assert.ok(p.answerable);
});

test('the hash does not change when the highlight moves', () => {
  const moved = claudePermission.replace(' ❯ 1. Yes', '   1. Yes').replace('   3. No', ' ❯ 3. No');
  const a = parsePrompt('claude', claudePermission)!, b = parsePrompt('claude', moved)!;
  assert.equal(a.hash, b.hash);
  assert.equal(b.selected, 2);
  assert.notEqual(parsePrompt('claude', claudePermission.replace(/touch out\/b\.txt/g, 'touch out/c.txt'))!.hash, a.hash);
});

test('a label that wraps onto the next row is joined', () => {
  const wrapped = claudePermission.replace('   2. Yes, and always allow access to /private/tmp/scratch/cc/out from this project',
    '   2. Yes, and always allow access to /private/tmp/claude-501/-Users-mariogarrido-taskboard-wt-one-inbox-for-agent-questions-and-choice-181/5d9bc09b-a\n      5b3-369d2f4ecd77/scratchpad/cc/out from this project');
  const p = parsePrompt('claude', wrapped)!;
  assert.equal(p.options.length, 3);
  assert.match(p.options[1].label, /from this project$/);
});

test('Claude Code plan approval: digits, the plan text, without the "tell Claude" row', () => {
  const screen = [
    '   Ready to code?', '   Here is Claude\'s plan:', '  ' + D,
    '   1. Create out/e.txt containing the text hello.', '   2. Verify by reading the file back.', '  ' + D, '  ' + W,
    '   Claude has written up a plan and is ready to execute. Would you like to proceed?',
    '   ❯ 1. Yes, auto-accept edits', '     2. Yes, manually approve edits', '     3. Tell Claude what to change',
    '        shift+tab to approve with this feedback', '   ctrl+g to edit in Vim · ~/.claude/plans/x.md',
  ].join('\n');
  const p = parsePrompt('claude', screen)!;
  assert.equal(p.name, 'claude-plan');
  assert.deepEqual(p.options.map(o => [o.label, o.key]), [['Yes, auto-accept edits', '1'], ['Yes, manually approve edits', '2']]);
  assert.match(p.details.plan || '', /Create out\/e\.txt/);
});

test('Claude Code trust dialog: no digits, "No, exit" is selected and risky', () => {
  const screen = [W, ' Accessing workspace:', ' /private/tmp/scratch/cc',
    ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not,',
    ' take a moment to review what\'s in this folder first.', ' Claude Code\'ll be able to read, edit, and execute files here.', ' Security guide',
    ' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel'].join('\n');
  const p = parsePrompt('claude', screen)!;
  assert.equal(p.name, 'claude-trust');
  assert.deepEqual(p.options.map(o => o.label), ['No, exit', 'Yes, I trust this folder']);
  assert.equal(p.options[0].risk, 'exits');
  assert.equal(p.options[0].key, undefined);
  assert.equal(p.selected, 0);
  assert.equal(p.details.cwd, '/private/tmp/scratch/cc');
  assert.equal(p.question, 'Is this a project you created or one you trust?');
});

test('Claude Code AskUserQuestion on the screen is shown, not answered by keys', () => {
  const screen = [W, ' ☐ Button Color', 'Which color should the button be?', '❯ 1. Red', '     A red button', '  2. Blue', '     A blue button', '  3. Type something.', W, '  4. Chat about this', 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');
  const p = parsePrompt('claude', screen)!;
  assert.equal(p.name, 'claude-question');
  assert.equal(p.answerable, false);
});

test('Codex command approval: shortcut keys, command and reason', () => {
  const screen = [
    '• Running sleep 20 && touch /private/tmp/x.txt',
    '  Would you like to run the following command?',
    '  Environment: local',
    '  Reason: Do you want to allow this command to create x.txt outside the workspace?',
    '  $ sleep 20 && touch',
    '  /private/tmp/x.txt',
    '› 1. Yes, proceed (y)',
    '  2. Yes, and don\'t ask again for commands that start with `sleep 20` (p)',
    '  3. No, and tell Codex what to do differently (esc)',
    '  Press enter to confirm or esc to cancel',
  ].join('\n');
  const p = parsePrompt('codex', screen)!;
  assert.equal(p.name, 'codex-approval');
  assert.equal(p.details.command, 'sleep 20 && touch /private/tmp/x.txt');
  assert.match(p.details.reason || '', /outside the workspace/);
  assert.deepEqual(p.options.map(o => o.key), ['y', 'p', 'Escape']);
  assert.equal(p.options[1].risk, 'wide-access');
});

test('Codex update dialog: arrow keys, "Update now" installs software', () => {
  const screen = ['  ✨ Update available! 0.158.0 -> 0.160.0', '', "› 1. Update now (runs `sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh'`)", '  2. Skip', '  3. Skip until next version', '', '  Press enter to continue'].join('\n');
  const p = parsePrompt('codex', screen)!;
  assert.equal(p.name, 'codex-update');
  assert.equal(p.options[0].risk, 'installs');
  assert.equal(p.options[0].key, undefined);
  assert.equal(p.selected, 0);
});

test('Codex usage limit dialog: "Yes" asks for credit', () => {
  const screen = ['  Usage limit reached', '  Request a limit increase from your owner to continue using codex.', '  Request increase?', '› 1. Yes (y)', '  2. No (default) (n)'].join('\n');
  const p = parsePrompt('codex', screen)!;
  assert.equal(p.name, 'codex-usage');
  assert.deepEqual(p.options.map(o => [o.key, o.risk]), [['y', 'spends'], ['n', undefined]]);
});

test('Codex trust dialog and questions', () => {
  const trust = ['  Folder access', '  /private/tmp/scratch/cx', '  Trust this folder? Codex can read, edit, and run files here.', '› 1. Trust and continue', '  2. Quit', '  enter continue · esc quit'].join('\n');
  const p = parsePrompt('codex', trust)!;
  assert.equal(p.name, 'codex-trust');
  assert.equal(p.options[1].risk, 'exits');
  const qs = parsePrompt('codex', '› Ask Codex\n? 2 questions · Start agents\n  shift+← to answer')!;
  assert.equal(qs.name, 'codex-questions');
  assert.equal(qs.answerable, false);
});

test('Antigravity approval and trust dialogs', () => {
  const approval = ['Run this command?', '  npm test -- --grep search', '> 1. Yes', '  2. Yes, and always allow npm commands in this workspace', '  3. No, cancel'].join('\n');
  const p = parsePrompt('antigravity', approval)!;
  assert.equal(p.name, 'agy-approval');
  assert.equal(p.details.command, 'npm test -- --grep search');
  assert.equal(p.options[0].key, undefined);
  const trust = ['Accessing workspace:', '/private/tmp/scratch/ag', 'Do you trust the contents of this project?', 'Antigravity CLI requires permission to read, edit, and execute files here.', '> Yes, I trust this folder', '  No, exit', '  ↑/↓ Navigate · enter Confirm'].join('\n');
  const t = parsePrompt('antigravity', trust)!;
  assert.equal(t.name, 'agy-trust');
  assert.deepEqual(t.options.map(o => o.label), ['Yes, I trust this folder', 'No, exit']);
});

test('a list without a known question is unknown; text in the input box is nothing', () => {
  const u = parsePrompt('antigravity', ['  Choose a profile for this workspace', '  > 1. Fast', '    2. Balanced', '  ↑/↓ Navigate · enter Confirm'].join('\n'))!;
  assert.equal(u.kind, 'unknown');
  assert.equal(u.answerable, false);
  assert.equal(parsePrompt('claude', [W, '❯ 1. first item of my message', W, '  ⏸ manual mode on'].join('\n')), null);
  assert.equal(parsePrompt('claude', 'just some output\n❯ '), null);
});

test('riskOf', () => {
  assert.equal(riskOf('Yes, and always allow access to /x from this project'), 'wide-access');
  assert.equal(riskOf('Update now (runs `curl | sh`)'), 'installs');
  assert.equal(riskOf('Yes (y)', 'Request increase?'), 'spends');
  assert.equal(riskOf('No, exit'), 'exits');
  assert.equal(riskOf('Yes, and don’t ask again for: touch *'), 'wide-access');
  assert.equal(riskOf('Skip'), undefined);
});

test('a list that scrolls in a short terminal: ↓ is not the highlight, and the prompt is partial', () => {
  const screen = [' ' + '╌'.repeat(80), ' Do you want to make this edit to log.md?', ' ❯ 1. Yes', ' ↓ 2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)'].join('\n');
  const p = parsePrompt('claude', screen + '\n Esc to cancel · Tab to amend')!;
  assert.equal(p.name, 'claude-permission');
  assert.equal(p.selected, 0);
  assert.equal(p.options.length, 2);
  assert.equal(p.options[1].risk, 'wide-access');
  assert.equal(p.partial, true);
});
