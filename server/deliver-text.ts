// Types a message into an agent's input box and presses Enter only when the box holds exactly that message.
// tb send, inbox notices, review feedback and the first prompts that do not fit on the command line all use it.
//
// Observed with Codex 0.158.0 and 0.160.0 in tmux 3.7c (tmux itself delivers every byte up to its 16 KB limit):
// - Codex takes fast typed input as a paste. With the old sequence (send-keys -l with the whole text, 400 ms, Enter),
//   Codex took the Enter as part of the paste at 1,000 to 12,000 characters, and nothing was submitted. Codex 0.160.0
//   also split the text into several "[Pasted Content N chars]" parts and needed up to 50 s to take 12,000 characters.
// - A bracketed paste (tmux paste-buffer -p) arrives in about one second. Codex shows "[Pasted Content N chars]" with
//   the exact length from 2,000 characters on, and Claude Code shows "[Pasted text #1]" from 1,000 characters on.
//   Shorter pastes show the text itself.
// So text longer than TYPE_MAX is pasted, and Enter is pressed only after the box shows the text or that placeholder.
import * as tmux from './tmux.ts';
import { inputBox, MARK, readyForInput, squash, type PromptAgent } from './type-command.ts';
import { agentName, blockingQuestion } from './agents.ts';
import type { Agent } from './store.ts';

export const TYPE_MAX = 100; // longer text is pasted
export const MAX_TEXT = 100_000;

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
// the bottom of the visible screen, where a question or dialog that waits for an answer sits
export const bottom = (screen: string, lines = 15) => screen.split('\n').filter(l => l.trim()).slice(-lines).join('\n');

// True when the agent's input box holds this text and nothing else: the text itself (rows joined, spaces ignored),
// or one paste placeholder. A Codex placeholder must name the length of the text.
export function holdsText(screen: string, text: string, agent: PromptAgent, pasted: boolean): boolean {
  const box = inputBox(screen, agent);
  if (box === null || !MARK[agent].test(box)) return false;
  const content = squash(box).slice(1);
  if (content === squash(text)) return true;
  if (!pasted) return false;
  const codex = /^\[PastedContent(\d+)chars\]$/.exec(content);
  if (codex) return [[...text].length, text.length].includes(Number(codex[1]));
  return agent !== 'codex' && /^\[Pastedtext#\d+\]$/.test(content);
}

export interface DeliverIO {
  tmux: (...args: string[]) => Promise<string>;
  capture: (session: string) => Promise<string>;
  paste: (session: string, text: string) => Promise<void>;
  wait: (ms: number) => Promise<void>;
}
const realIO: DeliverIO = { tmux: tmux.tmux, capture: s => tmux.capture(s, 0), paste: (s, text) => tmux.paste(s, text, false), wait };

export interface Delivered { submitted: boolean; warning?: string }
export interface Target { session: string; agent: Agent; num: number }

export function textError(text: unknown): string | null {
  if (typeof text !== 'string' || !text.trim()) return 'The text is empty. Nothing was typed and Enter was not pressed.';
  if (text.length > MAX_TEXT) return `The text is longer than ${MAX_TEXT} characters. Put it in a file and send the path.`;
  return null;
}

export async function deliverText(t: Target, raw: string, io: DeliverIO = realIO): Promise<Delivered> {
  const error = textError(raw);
  if (error) throw new Error(error);
  // one line, as before: a newline in the text must not act as Enter in an agent that reads the paste as typing
  const text = raw.replace(/\r?\n/g, ' ');
  const agent = t.agent as PromptAgent;
  if (!(agent in MARK)) throw new Error('Taskboard does not know the input box of this agent.');
  const name = agentName(t.agent), target = '=' + t.session + ':';
  const dialog = (screen: string) => blockingQuestion.test(bottom(screen));
  const asks = `${name} in #${t.num} asks a question or shows a dialog in its terminal. Answer it there, then send again.`;
  // a pane in copy mode would take the keys as copy-mode commands
  if ((await io.tmux('display-message', '-p', '-t', target, '#{pane_mode}')).trim() === 'copy-mode') await io.tmux('send-keys', '-X', '-t', target, 'cancel');
  let screen = await io.capture(t.session);
  if (dialog(screen)) throw new Error(`${asks} Nothing was typed.`);
  if (!readyForInput(screen, agent))
    throw new Error(`${name} in #${t.num} does not show an empty input box. It may ask a question, or its box may hold a draft. Nothing was typed.`);
  const pasted = text.length > TYPE_MAX;
  if (pasted) await io.paste(t.session, text);
  else await io.tmux('send-keys', '-t', target, '-l', text);
  const partly = `Enter was not pressed. The input box of #${t.num} may hold a part of the text: clear it in the terminal, then send again.`;
  let arrived = false;
  for (let i = 0; i < 60 && !arrived; i++) {
    await io.wait(i ? 250 : 300);
    screen = await io.capture(t.session);
    if (dialog(screen)) throw new Error(`${asks} ${partly}`);
    arrived = holdsText(screen, text, agent, pasted);
  }
  if (!arrived) throw new Error(`The text did not arrive whole in the input box of ${name} in #${t.num} within 15 s. ${partly}`);
  // Codex takes an Enter that comes right after fast input as a part of that input
  await io.wait(400);
  screen = await io.capture(t.session);
  if (dialog(screen) || !holdsText(screen, text, agent, pasted)) throw new Error(`The input box of ${name} in #${t.num} changed before Enter. ${partly}`);
  await io.tmux('send-keys', '-t', target, 'Enter');
  for (let i = 0; i < 12; i++) {
    await io.wait(250);
    if (!holdsText(await io.capture(t.session), text, agent, pasted)) return { submitted: true };
  }
  return { submitted: false, warning: `Enter was pressed, but the text is still in the input box of ${name} in #${t.num} after 3 s. Check its terminal.` };
}
