// Types a "! <command>" into a Claude Code task's prompt, for the hold-to-run gesture on the dashboard
// (web/src/bangCommand.ts). Claude Code runs a prompt that starts with "!" as a shell command in its own shell.
// Taskboard never runs the command itself. It sends the keys to the task's tmux pane, as the user would type them.
//
// Typed text joins any draft that is already in the prompt, and keys typed while Claude Code shows a question
// (for example a permission prompt, where a digit picks an answer) go to that question. So:
// 1. Before typing, the screen must show Claude Code's input box with the normal "❯" prompt, and no question.
// 2. After typing, the input box must show "!" and exactly this command. Only then is Enter pressed.
// If check 2 fails, the text stays in the prompt, Enter is not pressed, and the user decides.
import * as tmux from './tmux.ts';
import type { Task } from './store.ts';
import { blockingQuestion } from './agents.ts';

export const MAX_LENGTH = 1000;
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;
const RULE = /^─{10,}\s*$/;

export function commandError(command: unknown): string | null {
  if (typeof command !== 'string' || !command.trim()) return 'The command is empty.';
  if (command.length > MAX_LENGTH) return `The command is longer than ${MAX_LENGTH} characters.`;
  if (HIDDEN.test(command)) return 'The command contains control characters or hidden characters.';
  return null;
}

// The text in Claude Code's input box: the rows between the last two horizontal rules on the screen, joined.
export function inputBox(screen: string): string | null {
  const lines = screen.split('\n');
  let bottom = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (RULE.test(lines[i])) { bottom = i; break; }
  let top = -1;
  for (let i = bottom - 1; i >= 0; i--) if (RULE.test(lines[i])) { top = i; break; }
  if (top < 0 || bottom - top < 2) return null;
  return lines.slice(top + 1, bottom).map(l => l.trim()).join('\n');
}
const squash = (s: string) => s.replace(/\s+/g, '');
// Claude Code's own questions: a permission prompt ("Do you want to proceed?") lists numbered answers after "❯".
const QUESTION = /Do you want to|Would you like to|^\s*❯\s*\d+\.\s/m;
// The box is one row that starts with the "❯" prompt. (A grey suggestion can follow the prompt, and the plain
// screen text does not show that it is grey, so a draft is found only after typing, by showsCommand.)
export const readyForInput = (screen: string) => {
  const box = inputBox(screen);
  return box !== null && !box.includes('\n') && /^❯(?:\s|$)/.test(box) && !blockingQuestion.test(screen) && !QUESTION.test(screen);
};
// Claude Code shows the shell mode as "! " in front of the typed text.
export const showsCommand = (screen: string, command: string) => { const box = inputBox(screen); return box !== null && box.startsWith('!') && squash(box) === '!' + squash(command); };

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface Typed { ran: boolean; message: string }
export async function typeCommand(t: Task, command: string, io = { tmux: tmux.tmux, capture: (s: string) => tmux.capture(s, 0), wait }): Promise<Typed> {
  const error = commandError(command);
  if (error) throw new Error(error);
  if (t.agent !== 'claude') throw new Error('Hold to run works only in Claude Code tasks.');
  if (t.status === 'archived' || t.status === 'parked') throw new Error('This task is archived or set aside.');
  if (t.openElsewhere) throw new Error('This task is open in another terminal.');
  const target = '=' + t.session + ':';
  // a pane in copy mode would take the keys as copy-mode commands
  if ((await io.tmux('display-message', '-p', '-t', target, '#{pane_mode}')).trim() === 'copy-mode') await io.tmux('send-keys', '-X', '-t', target, 'cancel');
  if (!readyForInput(await io.capture(t.session)))
    throw new Error('Claude Code does not show an empty prompt. It may ask a question or have text in its prompt. Nothing was typed.');
  await io.tmux('send-keys', '-t', target, '-l', '!' + command);
  for (let i = 0; i < 20; i++) {
    await io.wait(100);
    if (showsCommand(await io.capture(t.session), command)) {
      await io.tmux('send-keys', '-t', target, 'Enter');
      return { ran: true, message: `Typed "! ${command}" into #${t.num} and pressed Enter.` };
    }
  }
  return { ran: false, message: `Typed "! ${command}" into #${t.num}, but its prompt did not show only this command. Enter was not pressed. Check the terminal.` };
}
