// Types a "! <command>" into a task's agent prompt, for the hold-to-run gesture on the dashboard
// (web/src/bangCommand.ts). Claude Code, Codex and Antigravity run a prompt that starts with "!" as a shell command.
// Taskboard never runs the command itself. It sends the keys to the task's tmux pane, as the user would type them.
//
// Typed text joins any draft that is already in the prompt, and keys typed while the agent shows a question
// (for example a permission prompt, where a digit picks an answer) go to that question. So:
// 1. Before typing, the screen must end with the agent's input box with its normal prompt mark, and no question.
// 2. After typing, the input box must show "!" and exactly this command. Only then is Enter pressed.
// If check 2 fails, the text stays in the prompt, Enter is not pressed, and the user decides.
import * as tmux from './tmux.ts';
import type { Task } from './store.ts';
import { agentName, blockingQuestion } from './agents.ts';

export const MAX_LENGTH = 1000;
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;
const RULE = /^─{10,}\s*$/;

export function commandError(command: unknown): string | null {
  if (typeof command !== 'string' || !command.trim()) return 'The command is empty.';
  if (command.length > MAX_LENGTH) return `The command is longer than ${MAX_LENGTH} characters.`;
  if (HIDDEN.test(command)) return 'The command contains control characters or hidden characters.';
  return null;
}

// Where each agent shows its prompt (observed in Claude Code 2.1.286, Codex 0.158.0 and Antigravity CLI 1.2.14):
// - Claude Code and Antigravity draw the input box between two horizontal rules. The prompt mark is "❯" or ">".
// - Codex has no rules. The prompt row starts with "›" in column 0, wrapped rows are indented, and a blank row and
//   the footer follow. Codex also shows earlier user messages with "›", so the box must be the last thing on screen.
// All three show "!" in place of the prompt mark in shell mode, and run the text as a shell command on Enter.
export type PromptAgent = 'claude' | 'codex' | 'antigravity';
export const MARK: Record<PromptAgent, RegExp> = { claude: /^❯(?:\s|$)/, antigravity: /^>(?:\s|$)/, codex: /^›(?:\s|$)/ };
const FOOTER_ROWS = 4; // at most this many rows with text below the box (status rows)
const below = (lines: string[], from: number) => lines.slice(from).filter(l => l.trim()).length;

// The text in the agent's input box, its rows trimmed and joined, or null when the screen does not end with one.
export function inputBox(screen: string, agent: PromptAgent = 'claude'): string | null {
  const lines = screen.replace(/\s+$/, '').split('\n');
  if (agent === 'codex') {
    let top = -1;
    for (let i = lines.length - 1; i >= 0; i--) if (/^[›!](?:\s|$)/.test(lines[i])) { top = i; break; }
    if (top < 0) return null;
    let end = top + 1;
    while (end < lines.length && /^ {2}\S/.test(lines[end])) end++;
    if (end < lines.length && lines[end].trim()) return null; // the box ends with a blank row
    if (below(lines, end) > FOOTER_ROWS) return null;
    return lines.slice(top, end).map(l => l.trim()).join('\n');
  }
  let bottom = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (RULE.test(lines[i])) { bottom = i; break; }
  let top = -1;
  for (let i = bottom - 1; i >= 0; i--) if (RULE.test(lines[i])) { top = i; break; }
  if (top < 0 || bottom - top < 2 || below(lines, bottom + 1) > FOOTER_ROWS) return null;
  return lines.slice(top + 1, bottom).map(l => l.trim()).join('\n');
}
export const squash = (s: string) => s.replace(/\s+/g, '');
const lastIndex = (list: string[], test: (s: string) => boolean) => { for (let i = list.length - 1; i >= 0; i--) if (test(list[i])) return i; return -1; };
// The agents' own questions. A permission prompt lists numbered answers after a mark ("❯ 1. Yes", "> 1. Yes, run
// command"). Its text is, for example, "Do you want to proceed?", "Would you like to run" or "Run this command?".
const QUESTION = /Do you want to|Would you like to|Requesting permission|Run this command\?|^\s*[❯>›]\s*\d+\.\s/m;
// What the bottom of an agent's screen shows, for typing a message into it:
// - empty: the input box holds no text, or only the agent's dim hint. The agent may be working: Claude Code and Codex
//   keep text that is submitted during a turn and give it to the model after the next tool call or at the end of the turn.
// - draft: the box holds text that a person typed (or the "!" of shell mode). Typed text would join it.
// - question: a permission question or another dialog waits for an answer. Typed keys would answer it.
// - no-box: the screen does not end with an input box (the agent starts, or shows a full-screen view).
// Only the box and the rows below it are searched for question words. Earlier output above the box often contains the
// same words (Claude Code 2.1.287 showed its own reply "Do you want to approve the merge?" above an empty box), and
// the agents draw their questions in place of the box or in it: Claude Code and Antigravity replace the box, and Codex
// shows the numbered answers with its "›" mark, where inputBox finds them.
export type BoxState = 'empty' | 'draft' | 'question' | 'no-box';
export function boxState(screen: string, agent: PromptAgent = 'claude'): BoxState {
  const plain = plainText(screen);
  const box = inputBox(plain, agent);
  const asks = (text: string) => blockingQuestion.test(text) || QUESTION.test(text);
  if (box === null) return asks(plain.split('\n').filter(l => l.trim()).slice(-15).join('\n')) ? 'question' : 'no-box';
  // the box and the rows below it: from the box row (Codex) or from the upper of the last two rules
  const lines = plain.replace(/\s+$/, '').split('\n');
  const rules = lines.flatMap((l, i) => RULE.test(l) ? [i] : []);
  const from = agent === 'codex' ? lastIndex(lines, l => /^[›!](?:\s|$)/.test(l)) : rules[rules.length - 2];
  if (asks(lines.slice(from).join('\n'))) return 'question';
  if (!MARK[agent].test(box) || box.includes('\n')) return 'draft';
  return typedText(screen, agent) ? 'draft' : 'empty';
}
// True when the box is empty: no question, and the box row has no text or only a hint.
export const readyForInput = (screen: string, agent: PromptAgent = 'claude') => boxState(screen, agent) === 'empty';

// Screens from `tmux capture-pane -e` keep the colors as SGR escape sequences ("ESC [ ... m"). The agents draw their
// hint text dim (SGR 2): Claude Code 2.1.287 shows "ESC[2mTry "fix lint errors"" and "ESC[2mPress up to edit queued
// messages", Codex 0.160.0 shows "ESC[2mAsk Codex to do anything". A person's draft is not dim. A plain screen (no
// escape sequence at all) cannot show this, so the text after the mark then counts as a hint, as before.
const ESCAPES = /\x1b\[[0-9;:?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]/g;
export const plainText = (screen: string) => screen.replace(ESCAPES, '');
function typedText(screen: string, agent: PromptAgent): boolean {
  if (!screen.includes('\x1b[')) return false;
  const rows = screen.replace(/\s+$/, '').split('\n');
  // the box row: the last row whose plain text starts with the mark
  const at = lastIndex(rows, r => MARK[agent].test(plainText(r)));
  if (at < 0) return false;
  const row = rows[at];
  let dim = false, seenMark = false;
  for (const part of row.split(/(\x1b\[[0-9;:]*m)/)) {
    const sgr = /^\x1b\[([0-9;:]*)m$/.exec(part);
    if (sgr) { dim = sgrDim(sgr[1], dim); continue; }
    for (const ch of plainText(part)) {
      if (!seenMark) { if (ch.trim()) seenMark = true; continue; } // the mark itself
      if (ch.trim() && !dim) return true;
    }
  }
  return false;
}
// The dim attribute after one SGR sequence. 38 and 48 (and 58) take a color as 5;n or 2;r;g;b, which is skipped.
function sgrDim(params: string, dim: boolean): boolean {
  const p = params.split(/[;:]/).map(x => x === '' ? 0 : Number(x));
  for (let i = 0; i < p.length; i++) {
    const n = p[i];
    if (n === 38 || n === 48 || n === 58) { i += p[i + 1] === 5 ? 2 : p[i + 1] === 2 ? 4 : 1; continue; }
    if (n === 0 || n === 22) dim = false;
    else if (n === 2) dim = true;
  }
  return dim;
}
// The box shows the shell mode "!" and then exactly this command.
export const showsCommand = (screen: string, command: string, agent: PromptAgent = 'claude') => {
  const box = inputBox(screen, agent);
  return box !== null && box.startsWith('!') && squash(box) === '!' + squash(command);
};

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface Typed { ran: boolean; message: string }
export async function typeCommand(t: Task, command: string, io = { tmux: tmux.tmux, capture: (s: string) => tmux.capture(s, 0), wait }): Promise<Typed> {
  const error = commandError(command);
  if (error) throw new Error(error);
  const agent = t.agent as PromptAgent;
  if (!(agent in MARK)) throw new Error('Hold to run does not know the prompt of this agent.');
  if (t.status === 'archived' || t.status === 'parked') throw new Error('This task is archived or set aside.');
  if (t.openElsewhere) throw new Error('This task is open in another terminal.');
  const target = '=' + t.session + ':';
  // a pane in copy mode would take the keys as copy-mode commands
  if ((await io.tmux('display-message', '-p', '-t', target, '#{pane_mode}')).trim() === 'copy-mode') await io.tmux('send-keys', '-X', '-t', target, 'cancel');
  if (!readyForInput(await io.capture(t.session), agent))
    throw new Error(`${agentName(t.agent)} does not show an empty prompt. It may ask a question or have text in its prompt. Nothing was typed.`);
  await io.tmux('send-keys', '-t', target, '-l', '!' + command);
  // Codex takes fast input as a paste and would take an Enter that comes at once as part of it (tmux.ts sendKeys)
  await io.wait(400);
  for (let i = 0; i < 20; i++) {
    if (i) await io.wait(100);
    if (showsCommand(await io.capture(t.session), command, agent)) {
      await io.tmux('send-keys', '-t', target, 'Enter');
      return { ran: true, message: `Typed "! ${command}" into #${t.num} and pressed Enter.` };
    }
  }
  return { ran: false, message: `Typed "! ${command}" into #${t.num}, but its prompt did not show only this command. Enter was not pressed. Check the terminal.` };
}
