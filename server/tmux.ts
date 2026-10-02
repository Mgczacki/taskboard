import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TB_DIR, TMUX_SOCKET } from './config.ts';

const exec = promisify(execFile);
export const TMUX_BIN = process.env.TASKBOARD_TMUX || 'tmux';

// tmux rewrites tabs and other characters in its output when the locale is not UTF-8 (as under launchd, which sets
// no locale). Always run it with a UTF-8 locale; the list below also uses a separator tmux never rewrites.
const TMUX_ENV = { ...process.env, LANG: process.env.LANG?.includes('UTF-8') ? process.env.LANG : 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' };
// A failed command throws an error whose message names the tmux command and its answer, not the whole command line
// (a start command holds the task instructions and the first prompt, more than 10 KB).
export async function tmux(...args: string[]): Promise<string> {
  try {
    const { stdout } = await exec(TMUX_BIN, ['-L', TMUX_SOCKET, ...args], { maxBuffer: 16 * 1024 * 1024, env: TMUX_ENV });
    return stdout;
  } catch (e) {
    const stderr = String((e as { stderr?: string }).stderr || '').trim();
    throw Object.assign(new Error(`tmux ${args[0]} failed: ${stderr || (e as Error).message.split('\n')[0].slice(0, 200)}`), { stderr, code: (e as { code?: unknown }).code });
  }
}

// tmux sends a command to its server in one message. With tmux 3.7c the arguments (each with its closing zero
// byte) may use at most 16,364 bytes; a longer command fails with "command too long" (measured with a binary search).
export const MAX_COMMAND_BYTES = 16_000;
export const commandBytes = (args: string[]) => args.reduce((n, a) => n + Buffer.byteLength(a) + 1, 0);
export const newSessionArgs = (name: string, cwd: string, env: Record<string, string>, command: string[]) =>
  ['new-session', '-d', '-s', name, '-c', cwd, '-x', '200', '-y', '50', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), ...command];

async function tmuxQuiet(...args: string[]): Promise<string | null> {
  try { return await tmux(...args); } catch { return null; }
}

export interface SessionInfo { name: string; activity: number; bell: boolean; panePid: number; dead: boolean; unscrollable: boolean }

const SEP = '|~|'; // printable, so no locale changes it; session names never contain it
// tmux's answer when its server (and so every session) is gone, as opposed to tmux failing to run or answer
const NO_SERVER = /no server running|error connecting to|No such file or directory|can't find session/i;
const errText = (e: unknown) => `${(e as { stderr?: string }).stderr || ''} ${(e as Error).message || ''}`;
// null means tmux could not be asked (the caller must not conclude that sessions are gone); [] means there are none
export async function listSessions(): Promise<SessionInfo[] | null> {
  let out: string;
  try { out = await tmux('list-panes', '-a', '-F', ['#{session_name}', '#{window_activity}', '#{window_bell_flag}', '#{pane_pid}', '#{pane_dead}', '#{alternate_on}', '#{mouse_any_flag}'].join(SEP)); }
  catch (e) { return NO_SERVER.test(errText(e)) ? [] : null; }
  if (out.trim() && !out.includes(SEP)) return null; // output in a format we did not ask for: do not guess
  return out.trim().split('\n').filter(Boolean).map(l => {
    const [name, activity, bell, pid, dead, alt, mouse] = l.split(SEP);
    // full screen without mouse reporting: tmux has no history for it and the program ignores the wheel, so it cannot be scrolled
    return { name, activity: Number(activity) * 1000, bell: bell === '1', panePid: Number(pid), dead: dead === '1', unscrollable: alt === '1' && mouse !== '1' };
  });
}

// true / false when tmux answered; null when it could not be asked
export async function hasSession(name: string): Promise<boolean | null> {
  try { await tmux('has-session', '-t', '=' + name); return true; }
  catch (e) { return NO_SERVER.test(errText(e)) ? false : null; }
}

// Server-wide options. escape-time 0 keeps Esc instant (Claude Code and Codex use Esc to interrupt).
// window-size latest lets the most recently active client decide the size when several windows attach.
// Mouse selection for programs that do not read the mouse themselves (Codex; Claude Code handles its own):
// tmux's defaults copy into its own buffer and drop the highlight the moment the mouse is released. These bindings
// keep the selection highlighted and copy it to the macOS clipboard (pbcopy). A click clears the highlight without
// leaving copy mode, so a drag can select older text. Esc leaves copy mode.
// A click that moves a few pixels is a drag and puts the pane in copy mode, where typed keys are copy-mode commands.
// So typing leaves copy mode: each printable key (and Space, Enter, BSpace, Tab) cancels it and goes on to the program.
// Written to a file and loaded with source-file because the nested commands do not pass well as arguments.
const keyArg = (k: string) => k === "'" ? `"'"` : `'${k}'`;
const TYPED = Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)); // ! through ~
export const COPY_BINDINGS = `
set -g mouse on
set -g set-clipboard on
set -as terminal-features 'xterm*:clipboard'
bind -T root DoubleClick1Pane select-pane -t = \\; if -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" { send -M } { copy-mode -H ; send -X select-word ; send -X copy-pipe-no-clear "pbcopy" }
bind -T root TripleClick1Pane select-pane -t = \\; if -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" { send -M } { copy-mode -H ; send -X select-line ; send -X copy-pipe-no-clear "pbcopy" }
${['copy-mode', 'copy-mode-vi'].map(t => `
bind -T ${t} MouseDragEnd1Pane send -X copy-pipe-no-clear "pbcopy"
bind -T ${t} DoubleClick1Pane select-pane \\; send -X select-word \\; send -X copy-pipe-no-clear "pbcopy"
bind -T ${t} TripleClick1Pane select-pane \\; send -X select-line \\; send -X copy-pipe-no-clear "pbcopy"
bind -T ${t} MouseDown1Pane select-pane \\; send -X clear-selection
bind -T ${t} Escape send -X cancel
${TYPED.map(k => `bind -T ${t} ${keyArg(k)} { send -X cancel ; send -l ${keyArg(k)} }`).join('\n')}
${['Space', 'Enter', 'BSpace', 'Tab'].map(k => `bind -T ${t} ${k} { send -X cancel ; send ${k} }`).join('\n')}`).join('')}
`;

export async function loadCopyBindings() {
  const f = join(TB_DIR, 'tmux-copy.conf');
  writeFileSync(f, COPY_BINDINGS);
  await tmuxQuiet('source-file', f);
}

export async function configureServer(bellHookCommand: string) {
  const opts: string[][] = [
    ['set-option', '-g', 'escape-time', '0'],
    ['set-option', '-g', 'history-limit', '5000'],
    ['set-option', '-g', 'status', 'off'],
    ['set-option', '-g', 'window-size', 'latest'],
    ['set-option', '-g', 'extended-keys', 'on'],
    ['set-option', '-g', 'focus-events', 'on'],
    ['set-option', '-g', 'default-terminal', 'tmux-256color'],
    ['set-option', '-as', 'terminal-features', 'xterm*:extkeys:RGB'],
    // mouse wheel: programs that ask for mouse events (Claude Code's full-screen view) scroll themselves; otherwise
    // tmux scrolls its own history. A drag selection is copied to the browser clipboard through OSC 52.
    ['set-option', '-g', 'mouse', 'on'],
    ['set-option', '-g', 'set-clipboard', 'on'],
    ['set-option', '-g', 'remain-on-exit', 'on'],
    ['set-window-option', '-g', 'monitor-bell', 'on'],
    ['set-option', '-g', 'bell-action', 'any'],
    ['set-option', '-g', 'visual-bell', 'off'],
    ['set-hook', '-g', 'alert-bell', bellHookCommand],
  ];
  for (const o of opts) await tmuxQuiet(...o);
  await loadCopyBindings();
}

export async function newSession(name: string, cwd: string, env: Record<string, string>, command: string[], onFirst: (hook: string) => Promise<void>) {
  const args = newSessionArgs(name, cwd, env, command);
  if (commandBytes(args) > MAX_COMMAND_BYTES) throw new Error(`The command that starts the agent has ${commandBytes(args)} bytes, and tmux accepts at most about ${MAX_COMMAND_BYTES}.`);
  // The first session starts the tmux server; server options can only be set once it exists.
  const running = (await tmuxQuiet('list-sessions')) !== null;
  await tmux(...args);
  if (!running) await onFirst(name);
}

export async function killSession(name: string) { await tmuxQuiet('kill-session', '-t', '=' + name); }

// Types text without checks. Agent messages go through deliver-text.ts, which checks the input box before Enter.
export async function sendKeys(name: string, text: string, enter = true) {
  await tmux('send-keys', '-t', '=' + name + ':', '-l', text);
  // Codex treats fast input as a paste and would take an immediate Enter as part of it; wait before submitting.
  if (enter) { await new Promise(r => setTimeout(r, 400)); await tmux('send-keys', '-t', '=' + name + ':', 'Enter'); }
}

// Paste text with several lines as one bracketed paste and submit it. Typed with send-keys, each newline would be an
// Enter and submit a part of it (Antigravity's first prompt, typed in after its trust question; see agents.ts).
export async function paste(name: string, text: string, enter = true) {
  const f = join(TB_DIR, `paste-${name}.txt`); writeFileSync(f, text);
  try { await tmux('load-buffer', '-b', `tb-${name}`, f); } finally { rmSync(f, { force: true }); }
  // -p wraps the text in bracketed paste marks when the program asked for them, so the program sees one paste
  await tmux('paste-buffer', '-p', '-d', '-b', `tb-${name}`, '-t', '=' + name + ':');
  if (!enter) return;
  await new Promise(r => setTimeout(r, 400));
  await tmux('send-keys', '-t', '=' + name + ':', 'Enter');
}

export async function capture(name: string, lines = 40): Promise<string> {
  return (await tmuxQuiet('capture-pane', '-p', '-t', '=' + name + ':', '-S', String(-lines))) || '';
}

// The visible screen with its colors and text attributes as SGR escape sequences (type-command.ts plainText removes them).
export async function captureStyled(name: string): Promise<string> {
  return (await tmuxQuiet('capture-pane', '-e', '-p', '-t', '=' + name + ':', '-S', '0')) || '';
}

// Everything the agent prints is also appended to a file, so output survives a reboot.
export async function pipeToFile(name: string, file: string) {
  await tmuxQuiet('pipe-pane', '-o', '-t', '=' + name + ':', `cat >> '${file.replace(/'/g, "'\\''")}'`);
}

export function quote(s: string) { return `'${s.replace(/'/g, "'\\''")}'`; }
