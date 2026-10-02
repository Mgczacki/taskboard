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
// The agents' own questions. A permission prompt lists numbered answers after a mark ("❯ 1. Yes", "> 1. Yes, run
// command"). Its text is, for example, "Do you want to proceed?", "Would you like to run" or "Run this command?".
const QUESTION = /Do you want to|Would you like to|Requesting permission|Run this command\?|^\s*[❯>›]\s*\d+\.\s/m;
// The box is one row that starts with the prompt mark. (A grey suggestion can follow the mark, and the plain
// screen text does not show that it is grey, so a draft is found only after typing, by showsCommand.)
export const readyForInput = (screen: string, agent: PromptAgent = 'claude') => {
  const box = inputBox(screen, agent);
  return box !== null && !box.includes('\n') && MARK[agent].test(box) && !blockingQuestion.test(screen) && !QUESTION.test(screen);
};
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
