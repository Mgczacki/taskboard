#!/usr/bin/env node
// PreToolUse guard for Claude Code sessions started by Taskboard (Bash tool only). Blocks commands that would stop
// the running Taskboard server or its agents from inside a Taskboard task: an agent working on Taskboard itself once
// stopped the real server with `pkill -f "tsx server/index.ts"` while meaning to stop its own test server.
// Runs without the server, so it also protects while the server is being restarted. Never fails the tool call.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
let cmd = '';
try { cmd = String(JSON.parse(input || '{}').tool_input?.command || ''); } catch { process.exit(0); }

// the real server: the one this agent's Taskboard runs (TASKBOARD_DIR is only set for test servers)
const tbDir = process.env.TASKBOARD_DIR || join(homedir(), '.taskboard');
let serverPid = '';
try { serverPid = String(JSON.parse(readFileSync(join(tbDir, 'server.pid'), 'utf8')).pid); } catch { /* not running */ }
const socket = process.env.TASKBOARD_TMUX_SOCKET || 'taskboard';

// each part of a command line separated by ; && || | or a newline is checked on its own
const parts = cmd.split(/;|&&|\|\||\||\n/);
const reasons = [];
for (const p of parts) {
  if (/\b(pkill|killall)\b/.test(p) && /server\/index|taskboard|\btsx\b|\bnode\b|\bnpx\b/i.test(p))
    reasons.push('pkill/killall by name can match the real Taskboard server, not only a test server');
  if (serverPid && /\bkill\b/.test(p) && new RegExp(`(^|[^0-9])${serverPid}([^0-9]|$)`).test(p))
    reasons.push(`process ${serverPid} is the running Taskboard server`);
  if (new RegExp(`tmux\\b.*-L\\s*${socket}\\b.*\\bkill-(server|session)\\b`).test(p))
    reasons.push(`tmux -L ${socket} holds the real agents and the controller`);
  if (/launchctl\b.*\b(bootout|unload|remove|kill)\b.*taskboard/i.test(p))
    reasons.push('this stops the Taskboard login service');
}
// releases and rollbacks switch the real Taskboard; only the user does that
if (/\bpnpm\s+(run\s+)?(release|rollback)\b|scripts\/(release|rollback)\.mjs/.test(cmd)) reasons.push('releasing or rolling back switches the real Taskboard, which only the user does');
// deleting or moving the real Taskboard's own folder (sandboxes live in the system temp folder instead)
if (/\b(rm|mv|rsync\s+--delete)\b[^\n]*(~|\$HOME|\/Users\/[^/\s]+)\/\.taskboard(\/(app|releases|server\.pid|token|hooks|bin))?(\/?\s|\/?$)/.test(cmd)) reasons.push('this deletes or moves the real Taskboard\'s folder ~/.taskboard');
// whole command: any stop command that names the server's pid file, entry point, port or tmux socket, also through
// indirections such as kill $(cat ~/.taskboard/server.pid) or pgrep -f server/index | xargs kill. Paths of sandboxes
// and worktrees (taskboard-sandbox, taskboard-wt) are not the real server and are ignored.
{
  // tmux kill-server / kill-session are judged by the socket rule above; a bare "taskboard" (the repository folder
  // ~/taskboard) is not the server
  const c = cmd.replace(/taskboard-(sandbox|wt)[^\s'"]*/g, '').replace(/\bkill-(server|session|pane|window)\b/g, '');
  if (/\b(kill|pkill|killall)\b/.test(c) && /server\.pid|server[\\/\[\]]*index|index\.ts|\btsx\b|\.taskboard\b/i.test(c)) reasons.push('this stop command names the real Taskboard server');
}
// whole command: killing whatever listens on the real server's port (lsof -ti tcp:4317 | xargs kill, fuser -k)
const port = process.env.TASKBOARD_PORT || '4317';
if (/\bkill\b|fuser\s+-k/.test(cmd) && new RegExp(`[:=\\s]${port}\\b`).test(cmd)) reasons.push(`port ${port} is the real Taskboard server`);
if (reasons.length) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: `Blocked by Taskboard: ${[...new Set(reasons)].join('; ')}. You are running inside Taskboard, so stopping it would cut off you and every other agent. ` +
      'To stop a test server, kill it by the process id you started it with (for example `... & PID=$!` and later `kill $PID`), or run `pnpm stop` with that server\'s TASKBOARD_DIR set. ' +
      'Test servers must use their own TASKBOARD_PORT, TASKBOARD_DIR, TASKBOARD_VAULT and TASKBOARD_TMUX_SOCKET (see CLAUDE.md in the Taskboard repository).' } }));
}
process.exit(0);
