#!/usr/bin/env node
// PreToolUse guard for Claude Code sessions (Bash tool) and Antigravity sessions (run_command tool, with --agy)
// started by Taskboard. Blocks commands that would stop
// the running Taskboard server or its agents from inside a Taskboard task: an agent working on Taskboard itself once
// stopped the real server with `pkill -f "tsx server/index.ts"` while meaning to stop its own test server.
// Runs without the server, so it also protects while the server is being restarted. Never fails the tool call.
import { readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
let cmd = '';
// Claude Code sends tool_input.command; agy sends toolCall.args.CommandLine
const agy = process.argv.includes('--agy');
if (agy && !process.env.TASK_ID) process.exit(0); // the agy plugin also runs in agy sessions that Taskboard did not start
try { const j = JSON.parse(input || '{}'); cmd = String((agy ? j.toolCall?.args?.CommandLine : j.tool_input?.command) || ''); } catch { process.exit(0); }

// the real server: the one this agent's Taskboard runs (TASKBOARD_DIR is only set for test servers)
const tbDir = process.env.TASKBOARD_DIR || join(homedir(), '.taskboard');
let serverPid = '';
try { serverPid = String(JSON.parse(readFileSync(join(tbDir, 'server.pid'), 'utf8')).pid); } catch { /* not running */ }
const socket = process.env.TASKBOARD_TMUX_SOCKET || 'taskboard';

// each part of a command line separated by ; && || | or a newline is checked on its own
const parts = cmd.split(/;|&&|\|\||\||\n/);
const reasons = [];
for (const p of parts) {
  if (process.env.TASK_WORKTREE && /^\s*git\s+(?:(?:-C|--git-dir|--work-tree)\s+\S+\s+)*(?:add|commit|rebase|merge|reset|checkout|switch|push|pull|cherry-pick|revert|worktree|update-ref|stash|branch|tag)\b/.test(p))
    reasons.push('use `tb git commit`, `tb git rebase`, or `tb git merge-request` for changes to Git refs in a Taskboard worktree');
  if (/\b(pkill|killall)\b/.test(p) && /server\/index|taskboard|\btsx\b|\bnode\b|\bnpx\b/i.test(p))
    reasons.push('pkill/killall by name can match the real Taskboard server, not only a test server');
  if (serverPid && /\bkill\b/.test(p) && new RegExp(`(^|[^0-9])${serverPid}([^0-9]|$)`).test(p))
    reasons.push(`process ${serverPid} is the running Taskboard server`);
  if (new RegExp(`tmux\\b.*-L\\s*${socket}\\b.*\\bkill-(server|session)\\b`).test(p))
    reasons.push(`tmux -L ${socket} holds the real agents and the controller`);
  if (/launchctl\b.*\b(bootout|unload|remove|kill)\b.*taskboard/i.test(p))
    reasons.push('this stops the Taskboard login service');
}
// The user approves one release for one task on the dashboard. The guard consumes that permit before the command runs.
const release = /\bpnpm\s+(run\s+)?release\b|scripts\/release\.mjs/.test(cmd);
const rollback = /\bpnpm\s+(run\s+)?rollback\b|scripts\/rollback\.mjs/.test(cmd);
if (release) {
  let allowed = false;
  const taskId = process.env.TASK_ID || '';
  if (/^[a-zA-Z0-9_-]+$/.test(taskId) && /^pnpm\s+(run\s+)?release$/.test(cmd.trim())) {
    const permit = join(tbDir, 'release-permits', taskId + '.json');
    try {
      const data = JSON.parse(readFileSync(permit, 'utf8'));
      if (data.taskId === taskId && Number(data.expiresAt) > Date.now()) {
        unlinkSync(permit);
        allowed = true;
      }
    } catch { /* no valid permit */ }
  }
  if (!allowed) reasons.push('a Taskboard release needs a dashboard approval for this task; run `tb release-request` first');
}
if (rollback) reasons.push('a Taskboard rollback needs the user to run it');
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
  const reason = `Blocked by Taskboard: ${[...new Set(reasons)].join('; ')}. You are running inside Taskboard, so stopping it would cut off you and every other agent. ` +
      'To stop a test server, kill it by the process id you started it with (for example `... & PID=$!` and later `kill $PID`), or run `pnpm stop` with that server\'s TASKBOARD_DIR set. ' +
      'Test servers must use their own TASKBOARD_PORT, TASKBOARD_DIR, TASKBOARD_VAULT and TASKBOARD_TMUX_SOCKET (see CLAUDE.md in the Taskboard repository).';
  // agy: no output means "no decision" (the normal approval question follows); so we print only a denial
  process.stdout.write(JSON.stringify(agy ? { decision: 'deny', reason }
    : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
}
process.exit(0);
