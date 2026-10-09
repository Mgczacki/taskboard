import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

// Claude Code 2.1.288 at start, when Claude in Chrome is not turned off and the extension is installed (task 204's terminal)
test('Claude Code "Claude in Chrome extension detected": a dialog with arrow keys, "No" selected, "Yes" gives wide access', () => {
  const screen = [W, ' Claude in Chrome extension detected', '',
    ' Claude will use your Chrome browser by default — navigating sites, filling forms, and', ' capturing screenshots in your existing session.', '',
    ' This session is in Auto mode, so an AI classifier approves routine browser actions —', ' you are only prompted when it is unsure. Turn browser tools off for future sessions', ' with /chrome.', '',
    ' ❯ No, keep browser tools off', '   Yes, use my browser', '', ' Enter to confirm · Esc to keep browser tools off'].join('\n');
  const p = parsePrompt('claude', screen)!;
  assert.equal(p.name, 'claude-chrome');
  assert.equal(p.kind, 'dialog');
  assert.equal(p.answerable, true);
  assert.deepEqual(p.options.map(o => [o.label, o.key, o.risk]), [['No, keep browser tools off', undefined, undefined], ['Yes, use my browser', undefined, 'wide-access']]);
  assert.equal(p.selected, 0);
  assert.match(p.question, /Claude in Chrome extension detected/);
  assert.match(p.excerpt, /Yes, use my browser/);
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

const choiceQuestion = readFileSync(new URL('./fixtures/screens/codex-choice-question.txt', import.meta.url), 'utf8');
test('Codex 0.160.0 live question: labels, descriptions, text option, and stable highlight', () => {
  const p = parsePrompt('codex', choiceQuestion)!;
  assert.equal(p.name, 'codex-question');
  assert.equal(p.kind, 'choice');
  assert.equal(p.answerable, true);
  assert.equal(p.textAnswer, true);
  assert.deepEqual(p.options.map(o => o.label), ['Start the task', 'I will remove the old scope', 'None of the above']);
  assert.equal(p.options[1].description, 'You will remove the old scope yourself.');
  const moved = choiceQuestion.replace('› 1.', '  1.').replace('  2.', '› 2.');
  assert.equal(parsePrompt('codex', moved)!.hash, p.hash);
  assert.notEqual(parsePrompt('codex', choiceQuestion.replace('yourself.', 'later.'))!.hash, p.hash);
});

test('Codex text fields, drafts, multiple questions, cut rows and changed submit bindings', () => {
  const notes = readFileSync(new URL('./fixtures/screens/codex-choice-notes.txt', import.meta.url), 'utf8');
  assert.equal(parsePrompt('codex', notes)!.answerable, false);
  assert.equal(parsePrompt('codex', notes.replace('› Add notes', '› start'))!.notes, 'start');
  const text = 'Question 1/1 (1 unanswered)\nWhat name should I use?\n\n› Type your answer (optional)\n\nenter to submit answer | esc to interrupt';
  assert.equal(parsePrompt('codex', text)!.kind, 'text');
  assert.equal(parsePrompt('codex', text)!.answerable, true);
  assert.equal(parsePrompt('codex', text.replace('Type your answer (optional)', 'someone else typed'))!.answerable, false);
  assert.match(parsePrompt('codex', choiceQuestion.replace('1/1', '1/2'))!.reason!, /several questions/);
  assert.match(parsePrompt('codex', choiceQuestion.replace('enter to submit', 'ctrl+s to submit'))!.reason!, /default Enter/);
  assert.match(parsePrompt('codex', choiceQuestion.replace('1. Start the task', '4. Start the task'))!.reason!, /missing/);
  assert.match(parsePrompt('codex', choiceQuestion.replace('Start the task               ', 'Start the…                  '))!.reason!, /cut off/);
});

test('screenshot #216: collapsed question has Read question, changes invalidate it, timers do not', () => {
  const screen = '• May I start a dedicated Taskboard task to replace the old scope advice?\n  • Start the task\n  • I will remove the old scope\n• Working (1m 19s • esc to interrupt)\n• Queued follow-up inputs\n  ? 1 question · 18s\n    shift+← to answer\n› Ask Codex to do anything\n  GPT-6-Sol medium';
  const p = parsePrompt('codex', screen)!;
  assert.equal(p.answerable, false);
  assert.equal(p.inspect, true);
  assert.equal(parsePrompt('codex', screen.replace('18s', '19s').replace('1m 19s', '1m 20s'))!.hash, p.hash);
  assert.notEqual(parsePrompt('codex', screen.replace('Start the task', 'Delete the task'))!.hash, p.hash);
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

test('Codex async composer supports options and text while refusing drafts and incomplete rows', () => {
  const screen = readFileSync(new URL('./fixtures/screens/codex-async-question.txt', import.meta.url), 'utf8');
  const p = parsePrompt('codex', screen)!;
  assert.equal(p.name, 'codex-async-question');
  assert.equal(p.answerable, true);
  assert.equal(p.textOption, 2);
  const draft = screen.replace('› 1.', '  1.').replace('  3. Other', '› 3. start');
  const d = parsePrompt('codex', draft)!;
  assert.equal(d.hash, p.hash);
  assert.equal(d.notes, 'start');
  assert.equal(d.answerable, false);
  assert.match(parsePrompt('codex', screen.replace('enter submit', 'ctrl+s submit'))!.reason!, /default Enter/);
  assert.match(parsePrompt('codex', screen.replace('1. Start', '4. Start'))!.reason!, /missing/);
  assert.match(parsePrompt('codex', screen.replace('May I start', '1 of 2\nMay I start'))!.reason!, /several questions/);
  const freeform = '• Queued follow-up inputs\nWhat exact text should I record?\n\n› Type your answer\n\nenter submit   ctrl+] skip   shift+→ main prompt';
  assert.equal(parsePrompt('codex', freeform)!.kind, 'text');
  assert.equal(parsePrompt('codex', freeform)!.answerable, true);
});
