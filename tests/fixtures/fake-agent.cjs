#!/usr/bin/env node
// A terminal program that draws the input box of Claude Code, Codex or Antigravity (as server/type-command.ts reads
// them) and records what is submitted. Used by tests that type into agents through tmux.
// - The agent is FAKE_AGENT, or the name the program was started with (claude, codex, agy).
// - TASK_DIR/input.txt gets every byte read. TASK_DIR/submitted.jsonl gets one line for each submitted message, and
//   for a prompt given on the command line. TASK_DIR/argv.json gets the arguments.
// - Codex mode acts like Codex 0.158.0 (observed): typed characters that arrive fast are one paste, and an Enter that
//   comes less than BURST_MS after them is part of that paste. A paste over 1,000 characters shows
//   "[Pasted Content N chars]". Claude Code mode shows "[Pasted text #n]" for a paste over 800 characters.
// - TEST_QUESTION=1 shows a trust question. FAKE_UPDATE=1 shows the box, then after 600 ms Codex's update dialog,
//   where Enter chooses "Update now" (recorded as UPDATE_CHOSEN) and Esc or 2 skips.
// - TASK_DIR/fake-state.json (read every 100 ms) changes the screen as Claude Code 2.1.287 drew it (observed):
//   busy: a spinner above the box and "esc to interrupt" below it. Enter keeps the text as a queued message, shown
//     above the spinner with "ctrl+x ctrl+s to send now", and the empty box shows the dim hint "Press up to edit queued
//     messages". When busy ends, the queued messages are submitted.
//   permission: the permission question in place of the box. "1" answers it. Other keys do nothing.
//   history: rows of earlier output above the box. notice: a background task notice above the box.
//   name: the session name in the upper rule, as claude --name draws it. footer: rows below the box (a status line).
//   drawing: only the history rows and no box, as a screen that the agent has not finished drawing.
//   An empty box shows its hint dim (SGR 2), as Claude Code and Codex do: Claude Code "Try ..." when hint is set, Codex
//   "Ask Codex to do anything".
const fs = require('node:fs'), path = require('node:path');
const agent = process.env.FAKE_AGENT || path.basename(process.argv[1]).replace(/^agy$/, 'antigravity');
const dir = process.env.TASK_DIR || process.cwd();
const BURST_MS = Number(process.env.FAKE_BURST_MS || 600);
const record = o => fs.appendFileSync(path.join(dir, 'submitted.jsonl'), JSON.stringify(o) + '\n');
fs.writeFileSync(path.join(dir, 'argv.json'), JSON.stringify(process.argv.slice(2)));

if (process.argv[2] === 'login' && process.argv[3] === 'status') { console.log('Logged in using ChatGPT'); return; }
if (process.argv[2] === 'auth' && process.argv[3] === 'status') { console.log(JSON.stringify({ loggedIn: true, email: 'fake@example.invalid' })); return; }
if (process.argv.includes('app-server')) { // Taskboard asks Codex for its hook hashes before it starts a task
  const rl = require('node:readline').createInterface({ input: process.stdin });
  rl.on('line', line => { const msg = JSON.parse(line);
    if (msg.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));
    // every hook given with -c hooks.<Event>=[...command="..."...], as Codex 0.160.0 lists them (task 267 added the
    // UserPromptSubmit, PostToolUse and Stop hooks for every Codex task)
    if (msg.id === 2) {
      const snake = e => e.replace(/[A-Z]/g, (c, i) => (i ? '_' : '') + c.toLowerCase());
      const hooks = [{ source: 'sessionFlags', eventName: 'preToolUse', command: 'node "$TB_HOOKS_DIR/guard.mjs"', key: '/<session-flags>/config.toml:pre_tool_use:0:0', currentHash: 'sha256:' + 'a'.repeat(64) }];
      for (const arg of process.argv) {
        const m = /^hooks\.([A-Za-z]+)=.*command=("(?:[^"\\]|\\.)*")/.exec(arg);
        if (m && m[1] !== 'PreToolUse') hooks.push({ source: 'sessionFlags', eventName: m[1][0].toLowerCase() + m[1].slice(1), command: JSON.parse(m[2]), key: `/<session-flags>/config.toml:${snake(m[1])}:0:0`, currentHash: 'sha256:' + 'b'.repeat(64) });
      }
      console.log(JSON.stringify({ id: 2, result: { data: [{ hooks }] } }));
    }
  });
  return;
}
const last = process.argv[process.argv.length - 1];
if (process.argv.length > 2 && !last.startsWith('-') && process.argv[process.argv.length - 2] !== '-c') record({ argv: true, text: last });

// rows wrap at the pane width, as the agents do (TASK_DIR/box.json gets the exact box text at each draw)
const RULE = '─'.repeat(80), width = () => Math.max(20, (process.stdout.columns || 154) - 4);
const parts = []; // the box: { text, shown }
let burst = null, burstTimer = null, pasting = null, pastes = 0, history = [];
let dialog = process.env.TEST_QUESTION === '1' ? 'trust' : null;
let state = {}, queued = [];
const stateFile = path.join(dir, 'fake-state.json');
setInterval(() => {
  let next = {}; try { next = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* none */ }
  if (JSON.stringify(next) === JSON.stringify(state)) return;
  const wasBusy = state.busy; state = next;
  if (state.permission) dialog = 'permission'; else if (dialog === 'permission') dialog = null;
  if (wasBusy && !state.busy) { for (const text of queued) { record({ text }); history.push(text); } queued = []; }
  draw();
}, 100);
const DIM = '\x1b[2m', RESET = '\x1b[0m';
const boxText = () => parts.map(p => p.shown).join('');
const fullText = () => parts.map(p => p.text).join('');
const add = (text, paste) => {
  const long = paste && (agent === 'codex' ? text.length > 1000 : agent === 'claude' ? text.length > 800 : false);
  parts.push({ text, shown: long ? (agent === 'codex' ? `[Pasted Content ${[...text].length} chars]` : `[Pasted text #${++pastes}]`) : text });
};
function draw() {
  let lines;
  if (dialog === 'trust') lines = ['Do you trust the contents of this project?', '> Yes, I trust this folder', '  No, exit'];
  else if (state.codexQuestion) lines = ['OpenAI Codex (fake)', '? 1 question', 'Shift+Left to answer', 'The question is still open'];
  else if (dialog === 'permission') lines = [...(state.history || []), '', '  Running ./build.sh', '  ⎿  $ ./build.sh', '', RULE, ' Bash command', ' Run shell command', '╌'.repeat(80), ' ./build.sh', '╌'.repeat(80),
    ' This command requires approval', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and don’t ask again for: ./build.sh *', '   3. No', '', ' Esc to cancel · Tab to amend'];
  else if (state.drawing) lines = ['Fake agent', ...(state.history || [])];
  else if (dialog === 'update') lines = ['  Update available · 0.158.0 → 0.160.0', '  Release notes: https://github.com/openai/codex/releases/latest', '',
    "› 1. Update now (runs `sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh'`)", '  2. Skip', '  3. Skip until next version', '', '  enter continue · esc skip'];
  else {
    // wrapped at word boundaries, as Codex and Claude Code do: a wrapped row never starts with a space
    // each line of the box text (a pasted draft keeps its lines) wraps on its own
    const text = boxText(), rows = [], WIDTH = width();
    for (const line of text.split('\n')) {
      let row = '';
      for (const w of line.split(/(?<= )/)) { if (row && (row + w).length > WIDTH) { rows.push(row.trimEnd()); row = w.trimStart(); } else row += w; }
      rows.push(row);
    }
    const mark = agent === 'codex' ? '›' : agent === 'claude' ? '❯' : '>';
    // the box row starts with a color code, as Claude Code ("ESC[39m❯") and Codex ("ESC[1m›ESC[0m") draw it
    const styled = agent === 'codex' ? '\x1b[1m›\x1b[0m' : '\x1b[39m' + mark;
    const hint = agent === 'codex' ? 'Ask Codex to do anything' : queued.length ? 'Press up to edit queued messages' : state.hint || '';
    const box = text ? rows.map((r, i) => (i ? '  ' : styled + ' ') + r) : [styled + ' ' + (hint ? DIM + hint + RESET : '')];
    const past = history.slice(-3).map(h => `${mark} ${h.slice(0, 60)}`);
    const above = [...(state.history || []), ...(state.notice ? ['⏺ Background command "./build.sh" completed (exit code 0)'] : []),
      ...queued.flatMap(q => [`${mark} ${q.slice(0, 60)}`, '  ctrl+x ctrl+s to send now']), ...(state.busy ? ['✻ Beaming… (8s · ↓ 231 tokens)'] : [])];
    // Claude Code draws its rules grey ("ESC[38;5;244m"), so a screen with colors always has escape codes
    const rule = '\x1b[38;5;244m' + RULE + '\x1b[39m';
    // claude --name draws the session name in the upper rule (Claude Code 2.1.288, observed on the controller)
    const upper = state.name ? '\x1b[38;5;244m' + '─'.repeat(60) + ` ${state.name} ─` + '\x1b[39m' : rule;
    lines = agent === 'codex' ? ['OpenAI Codex (fake)', '', ...past, ...above, '', ...box, '', '  ? for shortcuts'] : ['Fake agent', ...past, ...above, '', upper, ...box, rule, ...(state.footer || []), state.busy ? '  ⏸ manual mode on · esc to interrupt' : '  ? for shortcuts'];
  }
  process.stdout.write('\x1b[2J\x1b[H' + lines.join('\r\n'));
  fs.writeFileSync(path.join(dir, 'box.json'), JSON.stringify({ text: fullText(), shown: boxText() }));
}
process.stdout.on('resize', () => draw());
function submit() {
  const text = fullText(); parts.length = 0;
  if (state.busy && text) { queued.push(text); return draw(); }
  if (text) { record({ text }); history.push(text); }
  draw();
}
function endBurst() { burstTimer = null; if (burst !== null) { add(burst.replace(/\r/g, '\n'), burst.length > 1); burst = null; draw(); } }
function key(ch) {
  if (dialog || state.codexQuestion) {
    if (dialog === 'update' && ch === '\r') { record({ text: 'UPDATE_CHOSEN' }); process.exit(0); }
    if (dialog === 'update' && (ch === '\x1b' || ch === '2')) { dialog = null; draw(); }
    if (dialog === 'permission' && ch === '1') { record({ text: 'PERMISSION_ANSWERED' }); dialog = null; state = { ...state, permission: false }; fs.writeFileSync(stateFile, JSON.stringify(state)); draw(); }
    return;
  }
  if (burst !== null) { burst += ch; clearTimeout(burstTimer); burstTimer = setTimeout(endBurst, BURST_MS); return; }
  if (ch === '\r') return submit();
  if (ch === '\x7f') { const p = parts[parts.length - 1]; if (p) { p.text = p.text.slice(0, -1); p.shown = p.shown.slice(0, -1); if (!p.text) parts.pop(); } return draw(); }
  if (ch === '\x15') { parts.length = 0; return draw(); }
  if (ch >= ' ') { add(ch, false); draw(); }
}
let esc = '';
process.stdin.setRawMode(true);
process.stdout.write('\x1b[?2004h');
process.stdin.on('data', chunk => {
  fs.appendFileSync(path.join(dir, 'input.txt'), chunk);
  const s = chunk.toString('utf8');
  // keys such as Backspace (DEL) and Delete are not text: the real Codex 0.160.0 applies them one by one
  const printable = s.replace(/\x1b\[[0-9;?]*[~A-Za-z]/g, '').replace(/[\x00-\x1f\x7f]/g, '').length;
  // Codex: several characters in one read start a burst that the following reads join
  if (agent === 'codex' && burst === null && pasting === null && !dialog && printable > 1 && !s.includes('\x1b[200~')) { burst = ''; }
  for (const ch of s) {
    if (esc || ch === '\x1b') {
      esc += ch;
      if (esc === '\x1b[200~') { pasting = ''; esc = ''; }
      else if (esc === '\x1b[201~') { add(pasting.replace(/\r\n?/g, '\n'), true); pasting = null; esc = ''; draw(); }
      else if (esc.length > 1 && /[~A-Za-z]$/.test(esc.slice(1)) && esc !== '\x1b[') { esc = ''; }
      else if (esc.length === 1) { setTimeout(() => { if (esc === '\x1b') { esc = ''; key('\x1b'); } }, 30); }
      continue;
    }
    if (pasting !== null) { pasting += ch; continue; }
    key(ch);
  }
  if (burst !== null && !burstTimer) burstTimer = setTimeout(endBurst, BURST_MS);
});
draw();
if (process.env.FAKE_UPDATE === '1') setTimeout(() => { dialog = 'update'; draw(); }, 600);
setInterval(() => {}, 1000);
