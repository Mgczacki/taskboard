import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOME = homedir();
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PORT = Number(process.env.TASKBOARD_PORT || 4317);
export const HOST = '127.0.0.1';
export const URL_BASE = `http://${HOST}:${PORT}`;

// Everything the agents can read lives in the vault; everything private to the server lives in ~/.taskboard.
export const VAULT = process.env.TASKBOARD_VAULT || join(HOME, 'AgentVault');
export const TB_DIR = process.env.TASKBOARD_DIR || join(HOME, '.taskboard');
export const TASKS_DIR = join(VAULT, 'tasks');
export const DOCS_DIR = join(VAULT, 'docs');

// Agents run on their own tmux server (tmux -L taskboard) so they never mix with the user's own tmux.
export const TMUX_SOCKET = process.env.TASKBOARD_TMUX_SOCKET || 'taskboard';

for (const d of [VAULT, TASKS_DIR, DOCS_DIR, TB_DIR]) mkdirSync(d, { recursive: true });

// Hook scripts send this token so only processes on this machine that can read ~/.taskboard can post events.
const tokenFile = join(TB_DIR, 'token');
if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(24).toString('hex'), { mode: 0o600 });
export const TOKEN = readFileSync(tokenFile, 'utf8').trim();
export const TOKEN_FILE = tokenFile;

export const HOOK_SCRIPT = join(TB_DIR, 'hooks', 'claude-hook.mjs');
// The scripts the agents' CLIs run are copied to TB_DIR/hooks at start (see instance.ts), so running agents keep a
// working path when the server's code is replaced by a new release.
export const GUARD_SCRIPT = join(TB_DIR, 'hooks', 'guard.mjs');
export const STATUSLINE_SCRIPT = join(TB_DIR, 'hooks', 'claude-statusline.mjs');
export const CODEX_NOTIFY_SCRIPT = join(TB_DIR, 'hooks', 'codex-notify.mjs');
export const CLAUDE_SETTINGS_FILE = join(TB_DIR, 'claude-settings.json');
// Antigravity (agy) has no flag that passes hooks for one session. Taskboard installs these as the agy plugin
// "taskboard" (~/.gemini/config/plugins/taskboard); the scripts do nothing in agy sessions that Taskboard did not start.
export const AGY_HOOK_SCRIPT = join(TB_DIR, 'hooks', 'agy-hook.mjs');
export const AGY_STATUSLINE_SCRIPT = join(TB_DIR, 'hooks', 'agy-statusline.mjs');
export const AGY_PLUGIN_DIR = join(TB_DIR, 'agy-plugin');
export const AGY_HOME = join(HOME, '.gemini', 'antigravity-cli');
// The agy command: on the PATH, or where the official installer puts it (~/.local/bin is often not on the PATH of a
// server started at login).
export function agyBin(): string {
  for (const d of (process.env.PATH || '').split(':')) if (d && existsSync(join(d, 'agy'))) return join(d, 'agy');
  const local = join(HOME, '.local', 'bin', 'agy');
  return existsSync(local) ? local : 'agy';
}
