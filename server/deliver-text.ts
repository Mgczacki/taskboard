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
//
// A draft in the box (text that a person typed and did not send) does not stop a message (task 271). When the box text
// has not changed for DRAFT_QUIET_MS and no dashboard terminal sent a key in that time, Taskboard:
// 1. holds the keys of the dashboard terminals (terminal-input.ts), so a key cannot land in the middle;
// 2. reads the draft from the screen; when a row may be wrapped, it widens the window to WIDE_COLS for the read, so each
//    line of the draft is one row, then sets the width back;
// 3. saves the draft in TASK_DIR/drafts/ (the person can copy it from there if anything goes wrong);
// 4. empties the box with End, then Delete and Backspace keys (one for each character, plus a margin);
// 5. types the message and presses Enter, as for an empty box;
// 6. pastes the draft back without Enter (a bracketed paste keeps its lines), and checks that the box shows it.
// This is done with keys that the three agents read the same way (observed in Claude Code 2.1.289, Codex 0.160.0 and
// Antigravity 1.2.16 on 2026-10-05: a bracketed paste puts a multi-line draft in the box as text, End then Delete and
// Backspace empty it, and extra Delete and Backspace keys in an empty box do nothing). A draft that the screen does not
// show as text (a "[Pasted text #1]" or "[Image #1]" placeholder, or shell mode "!") is not moved: the message waits.
//
// A pane smaller than MIN_COLS x MIN_ROWS gets USABLE_COLS x USABLE_ROWS for the delivery (task 271: at 60x16 a 658
// character message did not fit in the visible box, typing failed and the text stayed in the box). With no terminal
// attached the size stays. A dashboard terminal that shows the pane gets its own size back after the delivery.
//
// When the text that Taskboard typed did not arrive whole, or Enter did not submit it, Taskboard removes that text from
// the box (the box was empty before) and the message is tried again: such a NotTyped has the state 'retry'. Text left
// in the box made every later message wait behind it as a "draft" (task 271).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as tmux from './tmux.ts';
import * as store from './store.ts';
import * as terminalInput from './terminal-input.ts';
import { boxRows, boxState, inputBox, MARK, plainText, squash, type BoxState, type PromptAgent } from './type-command.ts';
import { agentName } from './agents.ts';
import type { Agent } from './store.ts';

export const TYPE_MAX = 100; // longer text is pasted
export const MAX_TEXT = 100_000;
export const DRAFT_QUIET_MS = 3000;
export const MIN_COLS = 100, MIN_ROWS = 24, USABLE_COLS = 200, USABLE_ROWS = 50;
export const WIDE_COLS = 2000;

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
// the bottom of the visible screen, where a question or dialog that waits for an answer sits
export const bottom = (screen: string, lines = 15) => screen.split('\n').filter(l => l.trim()).slice(-lines).join('\n');

// True when the agent's input box holds this text and nothing else: the text itself (rows joined, spaces ignored),
// or one paste placeholder. A Codex placeholder must name the length of the text.
export function holdsText(screen: string, text: string, agent: PromptAgent, pasted: boolean): boolean {
  const box = inputBox(plainText(screen), agent);
  if (box === null || !MARK[agent].test(box)) return false;
  const content = squash(box).slice(1);
  if (content === squash(text)) return true;
  if (!pasted) return false;
  const codex = /^\[PastedContent(\d+)chars\]$/.exec(content);
  if (codex) return [[...text].length, text.length].includes(Number(codex[1]));
  return agent !== 'codex' && /^\[Pastedtext#\d+(?:\+\d+lines)?\]$/.test(content);
}

// Text that the screen shows in the box but that Taskboard cannot type back: a paste or image placeholder.
const PLACEHOLDER = /\[(?:Pasted text #\d+|Pasted Content \d+ chars|Image #\d+)[^\]]*\]/;
// The draft in the box as the person typed it: the rows of the box without the prompt mark and without the indent of
// two spaces that the agents put before the other rows, each row one line. Returns null when the box holds no draft
// that can be typed back (a placeholder, shell mode), and 'wrapped' when the row ends may not be line ends.
export function draftText(screen: string, agent: PromptAgent, cols: number): string | null | 'wrapped' {
  const rows = boxRows(plainText(screen), agent);
  if (!rows?.length) return null;
  const first = rows[0].replace(/^\s+/, '');
  if (!MARK[agent].test(first)) return null; // shell mode "!" or no mark
  // The agents wrap at word ends, so a wrapped row can end well before the edge: below WIDE_COLS every draft with more
  // than one row is read again in a wide window. There, only a row that reaches the edge can be wrapped.
  if ((rows.length > 1 && cols < WIDE_COLS) || rows.some(r => r.replace(/\s+$/, '').length >= cols - 2)) return 'wrapped';
  const lines = [first.replace(MARK[agent], '') /* the mark and the space after it */, ...rows.slice(1).map(r => r.startsWith('  ') ? r.slice(2) : r.replace(/^\s+/, ''))]
    .map(l => l.replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  const text = lines.join('\n');
  if (!text.trim() || PLACEHOLDER.test(text)) return null;
  return text;
}

export interface Size { cols: number; rows: number; clients: number }
export interface DeliverIO {
  tmux: (...args: string[]) => Promise<string>;
  capture: (session: string) => Promise<string>;
  paste: (session: string, text: string) => Promise<void>;
  wait: (ms: number) => Promise<void>;
  size: (session: string) => Promise<Size | null>;
  resize: (session: string, cols: number, rows: number) => Promise<void>;
  lastKeyAt: (session: string) => number;
  hold: (session: string) => () => void;
  saveDraft: (taskId: string | undefined, text: string) => string | null;
  now: () => number;
}
async function readSize(session: string): Promise<Size | null> {
  try {
    const [cols, rows, clients] = (await tmux.tmux('display-message', '-p', '-t', '=' + session + ':', '#{window_width} #{window_height} #{session_attached}')).trim().split(' ').map(Number);
    return cols > 0 && rows > 0 ? { cols, rows, clients: clients || 0 } : null;
  } catch { return null; }
}
function saveDraft(taskId: string | undefined, text: string): string | null {
  if (!taskId) return null;
  try {
    const dir = join(store.taskDir(taskId), 'drafts'); mkdirSync(dir, { recursive: true });
    const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
    writeFileSync(path, text + '\n');
    return path;
  } catch { return null; }
}
// the screen with its colors (tmux capture-pane -e): type-command.ts boxState tells a draft from a dim hint by them
const realIO: DeliverIO = {
  tmux: tmux.tmux, capture: s => tmux.captureStyled(s), paste: (s, text) => tmux.paste(s, text, false), wait,
  size: readSize, resize: async (s, cols, rows) => { await tmux.tmux('resize-window', '-t', '=' + s + ':', '-x', String(cols), '-y', String(rows)); },
  lastKeyAt: terminalInput.lastKeyAt, hold: terminalInput.hold, saveDraft, now: Date.now,
};

export interface Delivered { submitted: boolean; warning?: string; draft?: 'kept' | 'warning' }
export interface Target { session: string; agent: Agent; num: number; id?: string }

export function textError(text: unknown): string | null {
  if (typeof text !== 'string' || !text.trim()) return 'The text is empty. Nothing was typed and Enter was not pressed.';
  if (text.length > MAX_TEXT) return `The text is longer than ${MAX_TEXT} characters. Put it in a file and send the path.`;
  return null;
}

// Thrown when no text of the message stays in the box and Enter was not pressed, so the message can be typed later
// without harm. reason says why, for the sender and the dashboard. 'retry': Taskboard typed the message, it did not
// arrive whole or was not submitted, and Taskboard removed it again.
export class NotTyped extends Error {
  constructor(readonly reason: string, readonly state: BoxState | 'busy' | 'retry') { super(`${reason} Nothing was typed.`); }
}
// Why a screen does not take a message now, or null when its input box is empty.
export function notReadyReason(screen: string, agent: PromptAgent, name: string, num: number): NotTyped | null {
  const state = boxState(screen, agent);
  if (state === 'empty') return null;
  return new NotTyped(
    state === 'question' ? `${name} in #${num} asks a question or shows a dialog in its terminal.`
      : state === 'draft' ? `The input box of ${name} in #${num} holds a draft. Taskboard types the message when nobody has typed in the box for 3 s, and puts the draft back after it.`
      : `${name} in #${num} does not show its input box.`, state);
}

// What the box of each session showed at the last screen read, and since when. A draft is moved only after it stayed
// the same for DRAFT_QUIET_MS, which also covers keys typed from a terminal outside the dashboard.
const seenBox = new Map<string, { box: string; since: number }>();
export function noteBox(session: string, screen: string, agent: PromptAgent, now = Date.now()) {
  const box = inputBox(plainText(screen), agent) ?? '';
  const s = seenBox.get(session);
  if (!s || s.box !== box) seenBox.set(session, { box, since: now });
}
// True when the box text stayed the same, and no dashboard terminal sent a key, for DRAFT_QUIET_MS.
export function draftQuiet(session: string, screen: string, agent: PromptAgent, io: Pick<DeliverIO, 'lastKeyAt' | 'now'> = realIO): boolean {
  const now = io.now();
  noteBox(session, screen, agent, now);
  const s = seenBox.get(session)!;
  return now - s.since >= DRAFT_QUIET_MS && now - io.lastKeyAt(session) >= DRAFT_QUIET_MS;
}

// Waits until two screen reads in a row are the same (the agent finished drawing after a resize), at most `ms`.
async function settled(io: DeliverIO, session: string, ms = 2500): Promise<string> {
  let last = await io.capture(session);
  for (let waited = 0; waited < ms; waited += 200) {
    await io.wait(200);
    const next = await io.capture(session);
    if (next === last) return next;
    last = next;
  }
  return last;
}
// Gives a small pane a usable size. Returns the function that gives a watched pane its size back. A pane that no
// terminal shows keeps the new size: nobody sees it, and the next check of the queue reads the same screen.
export async function usableSize(io: DeliverIO, session: string): Promise<() => Promise<void>> {
  const size = await io.size(session);
  if (!size || (size.cols >= MIN_COLS && size.rows >= MIN_ROWS)) return async () => {};
  const cols = Math.max(size.cols, USABLE_COLS), rows = Math.max(size.rows, USABLE_ROWS);
  await io.resize(session, cols, rows);
  await settled(io, session);
  if (!size.clients) return async () => {};
  return async () => {
    // a viewer that changed the size in the meantime keeps its own size
    const now = await io.size(session);
    if (now && now.cols === cols && now.rows === rows) await io.resize(session, size.cols, size.rows);
  };
}

// The 2 s loop of message-queue.ts reads the screen before it types: a small pane that no terminal shows gets a usable
// size first, so the check can find the box. A pane that a terminal shows is resized only while a message is typed.
export async function fitUnwatched(session: string, io: DeliverIO = realIO) {
  const size = await io.size(session);
  if (size && !size.clients && (size.cols < MIN_COLS || size.rows < MIN_ROWS)) await io.resize(session, Math.max(size.cols, USABLE_COLS), Math.max(size.rows, USABLE_ROWS));
}

// Empties a box that holds only text, with End, then Delete and Backspace keys. False when the box is not empty after.
async function clearBox(io: DeliverIO, t: Target, agent: PromptAgent, chars: number): Promise<boolean> {
  const target = '=' + t.session + ':';
  const n = String(Math.min(chars + 20, 20_000));
  for (let i = 0; i < 3; i++) {
    const screen = await io.capture(t.session);
    const state = boxState(screen, agent);
    if (state === 'empty') return true;
    if (state !== 'draft') return false; // a question or dialog would take the keys as answers
    await io.tmux('send-keys', '-t', target, 'End');
    await io.tmux('send-keys', '-t', target, '-N', n, 'DC');
    await io.tmux('send-keys', '-t', target, '-N', n, 'BSpace');
    await io.wait(300);
  }
  return boxState(await io.capture(t.session), agent) === 'empty';
}

// Types the text into an empty box and presses Enter. On a failure after typing, removes the typed text when the box
// shows only text, and throws NotTyped 'retry'; otherwise throws an Error that says that a part may be in the box.
async function typeMessage(io: DeliverIO, t: Target, text: string, agent: PromptAgent): Promise<Delivered> {
  const name = agentName(t.agent), target = '=' + t.session + ':';
  const asks = (screen: string) => boxState(screen, agent) === 'question';
  const question = `${name} in #${t.num} asks a question or shows a dialog in its terminal. Answer it there, then send again.`;
  const partly = `Enter was not pressed. The input box of #${t.num} may hold a part of the text: clear it in the terminal, then send again.`;
  const removeAndRetry = async (why: string): Promise<never> => {
    if (await clearBox(io, t, agent, [...text].length + 10)) throw new NotTyped(`${why} Taskboard removed the text from the box and tries again.`, 'retry');
    throw new Error(`${why} ${partly}`);
  };
  const pasted = text.length > TYPE_MAX;
  if (pasted) await io.paste(t.session, text);
  else await io.tmux('send-keys', '-t', target, '-l', text);
  let arrived = false, screen = '';
  for (let i = 0; i < 60 && !arrived; i++) {
    await io.wait(i ? 250 : 300);
    screen = await io.capture(t.session);
    if (asks(screen)) throw new Error(`${question} ${partly}`);
    arrived = holdsText(screen, text, agent, pasted);
  }
  if (!arrived) return removeAndRetry(`The text did not arrive whole in the input box of ${name} in #${t.num} within 15 s.`);
  // Codex takes an Enter that comes right after fast input as a part of that input
  await io.wait(400);
  screen = await io.capture(t.session);
  if (asks(screen)) throw new Error(`${question} ${partly}`);
  if (!holdsText(screen, text, agent, pasted)) return removeAndRetry(`The input box of ${name} in #${t.num} changed before Enter.`);
  await io.tmux('send-keys', '-t', target, 'Enter');
  for (let i = 0; i < 36; i++) {
    await io.wait(250);
    if (!holdsText(await io.capture(t.session), text, agent, pasted)) return { submitted: true };
  }
  return removeAndRetry(`Enter was pressed, but the text was still in the input box of ${name} in #${t.num} after 9 s.`);
}

// Types the draft back into the empty box, without Enter, and checks that the box shows it.
async function putDraftBack(io: DeliverIO, t: Target, agent: PromptAgent, draft: string): Promise<boolean> {
  let state: BoxState = 'no-box';
  // the agent may show a question right after the message (a permission prompt): keys would answer it
  for (let i = 0; i < 20; i++) { state = boxState(await io.capture(t.session), agent); if (state === 'empty') break; await io.wait(250); }
  if (state !== 'empty') return false;
  const pasted = draft.includes('\n') || draft.length > TYPE_MAX;
  if (pasted) await io.paste(t.session, draft);
  else await io.tmux('send-keys', '-t', '=' + t.session + ':', '-l', draft);
  for (let i = 0; i < 20; i++) {
    await io.wait(250);
    if (holdsText(await io.capture(t.session), draft, agent, pasted)) return true;
  }
  return false;
}

// Moves the draft out of the box, types the message, and puts the draft back. The caller made sure the draft is quiet.
async function aroundDraft(io: DeliverIO, t: Target, text: string, agent: PromptAgent, screen: string): Promise<Delivered> {
  const name = agentName(t.agent);
  const release = io.hold(t.session);
  try {
    const size = await io.size(t.session);
    let draft = draftText(screen, agent, size?.cols || 80);
    if (draft === 'wrapped' && size) {
      // a wide window shows each line of the draft on one row
      await io.resize(t.session, WIDE_COLS, size.rows);
      const wide = await settled(io, t.session);
      const now = await io.size(t.session);
      draft = draftText(wide, agent, now?.cols || size.cols);
      if (now && now.cols === WIDE_COLS) await io.resize(t.session, size.cols, size.rows);
      await settled(io, t.session);
    }
    if (draft === null || draft === 'wrapped')
      throw new NotTyped(`The input box of ${name} in #${t.num} holds text that Taskboard cannot type back exactly (a pasted block, an image, a shell command, or a line longer than ${WIDE_COLS - 2} characters). The message waits until the person sends or clears that text.`, 'draft');
    // the box must still show the same text: the screen was read before the hold started
    if (squash(inputBox(plainText(await io.capture(t.session)), agent) || '') !== squash(inputBox(plainText(screen), agent) || ''))
      throw new NotTyped(`The input box of ${name} in #${t.num} changed while Taskboard read the draft.`, 'draft');
    const file = io.saveDraft(t.id, draft);
    const kept = file ? ` It is saved in ${file}.` : '';
    if (!await clearBox(io, t, agent, [...draft].length + draft.split('\n').length)) {
      const back = await putDraftBack(io, t, agent, draft).catch(() => false);
      throw new Error(`Taskboard could not empty the input box of ${name} in #${t.num} to type the message. ${back ? 'The draft is back in the box.' : 'The box may not show the draft as it was.'}${kept}`);
    }
    let result: Delivered | undefined, failure: unknown;
    try { result = await typeMessage(io, t, text, agent); } catch (e) { failure = e; }
    // after a failure that left text in the box, the draft cannot go back without mixing with it
    const back = failure && !(failure instanceof NotTyped) ? false : await putDraftBack(io, t, agent, draft).catch(() => false);
    const warning = back ? undefined : `Taskboard took a draft out of the input box of ${name} in #${t.num} to type a message, and could not put it back as it was.${kept || ' Taskboard could not save it.'}`;
    if (failure) {
      if (warning && failure instanceof Error) failure.message += ` ${warning}`;
      throw failure;
    }
    return { ...result!, draft: back ? 'kept' : 'warning', ...(warning ? { warning } : {}) };
  } finally { release(); }
}

export interface DeliverOptions { keepDraft?: boolean } // false: a draft makes the message wait (default true)
export async function deliverText(t: Target, raw: string, io: DeliverIO = realIO, opts: DeliverOptions = {}): Promise<Delivered> {
  const error = textError(raw);
  if (error) throw new Error(error);
  // one line, as before: a newline in the text must not act as Enter in an agent that reads the paste as typing
  const text = raw.replace(/\r?\n/g, ' ');
  const agent = t.agent as PromptAgent;
  if (!(agent in MARK)) throw new Error('Taskboard does not know the input box of this agent.');
  const name = agentName(t.agent), target = '=' + t.session + ':';
  // a pane in copy mode would take the keys as copy-mode commands
  if ((await io.tmux('display-message', '-p', '-t', target, '#{pane_mode}')).trim() === 'copy-mode') await io.tmux('send-keys', '-X', '-t', target, 'cancel');
  const restoreSize = await usableSize(io, t.session);
  try {
    const screen = await io.capture(t.session);
    const state = boxState(screen, agent);
    noteBox(t.session, screen, agent, io.now());
    if (state === 'draft' && opts.keepDraft !== false) {
      if (!draftQuiet(t.session, screen, agent, io))
        throw new NotTyped(`The input box of ${name} in #${t.num} holds a draft. Taskboard types the message when the draft has not changed and no key was typed for 3 s, and puts the draft back after it.`, 'draft');
      return await aroundDraft(io, t, text, agent, screen);
    }
    const notReady = notReadyReason(screen, agent, name, t.num);
    if (notReady) throw notReady;
    return await typeMessage(io, t, text, agent);
  } finally { await restoreSize().catch(() => {}); }
}
