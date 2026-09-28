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

export const HOOK_SCRIPT = join(ROOT, 'server', 'hooks', 'claude-hook.mjs');
export const STATUSLINE_SCRIPT = join(ROOT, 'server', 'hooks', 'claude-statusline.mjs');
export const CODEX_NOTIFY_SCRIPT = join(ROOT, 'server', 'hooks', 'codex-notify.mjs');
export const CLAUDE_SETTINGS_FILE = join(TB_DIR, 'claude-settings.json');
