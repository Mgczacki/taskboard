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
    if (msg.id === 2) console.log(JSON.stringify({ id: 2, result: { data: [{ hooks: [{ source: 'sessionFlags', eventName: 'preToolUse', command: 'node "$TB_HOOKS_DIR/guard.mjs"', key: '/<session-flags>/config.toml:pre_tool_use:0:0', currentHash: 'sha256:' + 'a'.repeat(64) }] }] } }));
  });
  return;
}
const last = process.argv[process.argv.length - 1];
if (process.argv.length > 2 && !last.startsWith('-') && process.argv[process.argv.length - 2] !== '-c') record({ argv: true, text: last });

const RULE = '─'.repeat(80), WIDTH = 150;
const parts = []; // the box: { text, shown }
let burst = null, burstTimer = null, pasting = null, pastes = 0, history = [];
let dialog = process.env.TEST_QUESTION === '1' ? 'trust' : null;
const boxText = () => parts.map(p => p.shown).join('');
const fullText = () => parts.map(p => p.text).join('');
const add = (text, paste) => {
  const long = paste && (agent === 'codex' ? text.length > 1000 : agent === 'claude' ? text.length > 800 : false);
  parts.push({ text, shown: long ? (agent === 'codex' ? `[Pasted Content ${[...text].length} chars]` : `[Pasted text #${++pastes}]`) : text });
};
function draw() {
  let lines;
  if (dialog === 'trust') lines = ['Do you trust the contents of this project?', '> Yes, I trust this folder', '  No, exit'];
  else if (dialog === 'update') lines = ['  Update available · 0.158.0 → 0.160.0', '  Release notes: https://github.com/openai/codex/releases/latest', '',
    "› 1. Update now (runs `sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh'`)", '  2. Skip', '  3. Skip until next version', '', '  enter continue · esc skip'];
  else {
    // wrapped at word boundaries, as Codex and Claude Code do: a wrapped row never starts with a space
    const text = boxText(), rows = [];
    let row = '';
    for (const w of text.split(/(?<= )/)) { if (row && (row + w).length > WIDTH) { rows.push(row.trimEnd()); row = w.trimStart(); } else row += w; }
    rows.push(row);
    const mark = agent === 'codex' ? '›' : agent === 'claude' ? '❯' : '>';
    const box = text ? rows.map((r, i) => (i ? '  ' : mark + ' ') + r) : [mark + (agent === 'codex' ? ' Ask Codex to do anything' : ' ')];
    const past = history.slice(-3).map(h => `${mark} ${h.slice(0, 60)}`);
    lines = agent === 'codex' ? ['OpenAI Codex (fake)', '', ...past, '', ...box, '', '  ? for shortcuts'] : ['Fake agent', ...past, '', RULE, ...box, RULE, '  ? for shortcuts'];
  }
  process.stdout.write('\x1b[2J\x1b[H' + lines.join('\r\n'));
}
function submit() {
  const text = fullText(); parts.length = 0;
  if (text) { record({ text }); history.push(text); }
  draw();
}
function endBurst() { burstTimer = null; if (burst !== null) { add(burst.replace(/\r/g, '\n'), burst.length > 1); burst = null; draw(); } }
function key(ch) {
  if (dialog) {
    if (dialog === 'update' && ch === '\r') { record({ text: 'UPDATE_CHOSEN' }); process.exit(0); }
    if (dialog === 'update' && (ch === '\x1b' || ch === '2')) { dialog = null; draw(); }
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
  const printable = s.replace(/\x1b\[[0-9;?]*[~A-Za-z]/g, '').length;
  // Codex: several characters in one read start a burst that the following reads join
  if (agent === 'codex' && burst === null && pasting === null && !dialog && printable > 1 && !s.includes('\x1b[200~')) { burst = ''; }
  for (const ch of s) {
    if (esc || ch === '\x1b') {
      esc += ch;
      if (esc === '\x1b[200~') { pasting = ''; esc = ''; }
      else if (esc === '\x1b[201~') { add(pasting, true); pasting = null; esc = ''; draw(); }
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
