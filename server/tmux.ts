import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { STABLE_DIR, TB_DIR, TMUX_SOCKET, TOKEN_FILE, URL_BASE } from './config.ts';
import * as settings from '../scripts/tmux-settings.mjs';

const exec = promisify(execFile);
export const TMUX_BIN = process.env.TASKBOARD_TMUX || 'tmux';

// tmux rewrites tabs and other characters in its output when the locale is not UTF-8 (as under launchd, which sets
// no locale). Always run it with a UTF-8 locale; the list below also uses a separator tmux never rewrites.
// PWD is left out: the first tmux command starts the tmux server, which keeps PWD in its global environment.
const { PWD: _pwd, ...ENV } = process.env;
const TMUX_ENV = { ...ENV, LANG: process.env.LANG?.includes('UTF-8') ? process.env.LANG : 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' };
// Every tmux command runs from STABLE_DIR (the home folder). The first command starts the tmux server, and the tmux
// server keeps the working directory of that command for its whole life. On 4 October 2026 it was a release folder;
// a later release removed it, and from then on tmux 3.7c started each new pane in the deleted folder, even with -c.
// A failed command throws an error whose message names the tmux command and its answer, not the whole command line
// (a start command holds the task instructions and the first prompt, more than 10 KB).
export async function tmux(...args: string[]): Promise<string> {
  try {
    const { stdout } = await exec(TMUX_BIN, ['-L', TMUX_SOCKET, ...args], { maxBuffer: 16 * 1024 * 1024, env: TMUX_ENV, cwd: STABLE_DIR });
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
  ['new-session', '-d', '-s', name, '-c', cwd, '-x', '200', '-y', '50', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), ...inFolder(cwd, command)];
// The command changes to its folder itself before it runs. A tmux server whose own working directory was deleted
// ignores -c (observed with tmux 3.7c): the pane then starts in the deleted folder, and Claude Code stops with "The
// current working directory was deleted". With this, a task still starts on such a tmux server.
export const inFolder = (cwd: string, command: string[]) =>
  command.length ? ['/bin/sh', '-c', 'cd "$0" && exec "$@"', resolve(cwd), ...command] : command;

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

// The global options of the tmux server (status bar off, mouse on, remain-on-exit on, the bell hook, the copy-mode
// bindings) are listed in scripts/tmux-settings.mjs, which pnpm doctor uses too. The tmux server carries the marker
// option MARK with the settings version once they are set. ensureConfigured reads it and sets the options when it is
// missing or old: after the tmux server ended and a new one started (tmux kill-server while Taskboard runs), or when
// something other than newSession started the tmux server (a process window of task-procs.ts, or the user).
const run = (args: string[]) => tmux(...args);
const token = () => readFileSync(TOKEN_FILE, 'utf8').trim();
export const loadCopyBindings = () => settings.loadBindings(run, settings.bindingsFileIn(TB_DIR));

// Calls at the same time share one run, so two sessions that start together configure the tmux server once.
// A second run from another process (pnpm doctor) sets the same values again, which changes nothing.
let configuring: Promise<boolean> | null = null;
// true when it set the options now; false when the marker matched or no tmux server runs
export function ensureConfigured(): Promise<boolean> {
  configuring ||= (async () => {
    try {
      const mark = await settings.readMark(run);
      if (mark === null || mark === settings.SETTINGS_VERSION) return false;
      await settings.applySettings(run, token(), URL_BASE, settings.bindingsFileIn(TB_DIR));
      return true;
    } finally { configuring = null; }
  })();
  return configuring;
}

// The settings that differ from the expected values: [] when they all match, null when no tmux server runs.
export const compareSettings = () => settings.compareSettings(run, token(), URL_BASE);

// At server start and every minute (tmux-health.ts): compare the live options with the expected ones and set them
// when they differ. They are global options, so this changes no session. Returns the names that differed.
export async function repairSettings(): Promise<string[] | null> {
  const differ = await compareSettings();
  if (!differ?.length) return differ;
  await settings.applySettings(run, token(), URL_BASE, settings.bindingsFileIn(TB_DIR));
  return differ;
}

export async function newSession(name: string, cwd: string, env: Record<string, string>, command: string[]) {
  let args = newSessionArgs(name, cwd, env, command);
  let launchFile: string | undefined;
  if (commandBytes(args) > MAX_COMMAND_BYTES) {
    // tmux limits the size of one request. A private, single-use shell file carries the exact argv and environment.
    // Quote each value as shell data. The file removes itself before exec, and tmux receives only its path.
    launchFile = join(TB_DIR, `agent-launch-${randomUUID()}.sh`);
    const withEnv = newSessionArgs(name, cwd, env, ['/bin/sh', launchFile]);
    // Keep tmux's session environment when it fits. If the environment alone is too long, set it in the pane.
    const envInTmux = commandBytes(withEnv) <= MAX_COMMAND_BYTES;
    const shellEnv = envInTmux ? {} : env;
    for (const key of Object.keys(shellEnv)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('The agent environment has an invalid variable name.');
    const exports = Object.entries(shellEnv).map(([key, value]) => `export ${key}=${quote(value)}`).join('\n');
    writeFileSync(launchFile, `#!/bin/sh\nrm -f -- "$0"\n${exports}\nexec ${command.map(quote).join(' ')}\n`, { flag: 'wx', mode: 0o600 });
    args = envInTmux ? withEnv : newSessionArgs(name, cwd, {}, ['/bin/sh', launchFile]);
  }
  if (commandBytes(args) > MAX_COMMAND_BYTES) {
    if (launchFile) rmSync(launchFile, { force: true });
    throw new Error(`The command that starts the agent has ${commandBytes(args)} bytes, and tmux accepts at most about ${MAX_COMMAND_BYTES}.`);
  }
  try { await tmux(...args); }
  catch (e) { if (launchFile) rmSync(launchFile, { force: true }); throw e; }
  // the session may have started the tmux server; options can only be set once it exists
  await ensureConfigured();
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
