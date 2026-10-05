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
// tb new passes its prompt to a new task. Quoted text and literal words cannot run a second shell command.
const launch = cmd.trim().match(/^(tb|\/[^\s]+)[ \t]+new(?=[ \t]|$)(.*)$/s);
const literalArgs = /^(?:[ \t]+(?:'[^'\r\n]*'|"[^"$`\\\r\n]*"|[^\s;&|`$<>(){}'"\\#]+))*[ \t]*$/;
if (process.env.TASK_ID === 'controller' && launch &&
    (launch[1] === 'tb' || launch[1] === join(tbDir, 'bin', 'tb')) && literalArgs.test(launch[2])) process.exit(0);
// A quoted message is data for the controller. Check the whole shell command so that no second action can run.
// Double quotes cannot contain shell expansion or escapes. Single quotes keep those characters literal.
const contact = cmd.trim().match(/^(tb|\/\S+)\s+send\s+controller\s+(.+)$/);
if (contact && (contact[1] === 'tb' || contact[1] === join(tbDir, 'bin', 'tb')) &&
    (/^'[^'\r\n]+'$/.test(contact[2]) || /^"[^"$`\\\r\n]+"$/.test(contact[2]))) process.exit(0);
let serverPid = '';
try { serverPid = String(JSON.parse(readFileSync(join(tbDir, 'server.pid'), 'utf8')).pid); } catch { /* not running */ }
const socket = process.env.TASKBOARD_TMUX_SOCKET || 'taskboard';

// each part of a command line separated by ; && || | or a newline is checked on its own
const parts = cmd.split(/;|&&|\|\||\||\n/);
const reasons = [];
for (const p of parts) {
  if (process.env.TASK_ID && process.env.TASK_ID !== 'controller' && /^\s*(?:[A-Z_][A-Z0-9_]*=\S+\s+)*(?:\S*\/)?git\s+(?:(?:-C|--git-dir|--work-tree)\s+\S+\s+)*(?:add|commit|rebase|merge|reset|checkout|switch|push|pull|cherry-pick|revert|worktree|update-ref|stash|branch|tag)\b/.test(p))
    reasons.push(process.env.TASK_WORKTREE
      ? 'run `tb git commit`, `tb git rebase`, `tb git repair`, or `tb git merge-request` for Git writes in a Taskboard task. To change another repository, run `tb scope request worktree --repo <main checkout> --base origin/<branch> --branch <new branch> --reason "<why>"` and then use `tb git commit --worktree <name>`'
      : 'this task has no worktree. Run `tb scope request worktree --repo <main checkout> --base origin/<branch> --branch <new branch> --reason "<why>"`, for example `tb scope request worktree --repo ~/code/app --base origin/master --branch task/fix-login --reason "Fix the login bug"`. The user approves it on the dashboard. Then run `tb git commit`, `tb git rebase`, `tb git repair`, or `tb git merge-request` with `--worktree <name>`');
  if (/\b(pkill|killall)\b/.test(p) && /server\/index|taskboard|\btsx\b|\bnode\b|\bnpx\b/i.test(p))
    reasons.push('pkill/killall by name can match the real Taskboard server, not only a test server');
  if (serverPid && /\bkill\b/.test(p) && new RegExp(`(^|[^0-9])${serverPid}([^0-9]|$)`).test(p))
    reasons.push(`process ${serverPid} is the running Taskboard server`);
  if (new RegExp(`tmux\\b.*-L\\s*${socket}\\b.*\\bkill-(server|session)\\b`).test(p))
    reasons.push(`tmux -L ${socket} holds the real agents and the controller`);
  if (/launchctl\b.*\b(bootout|unload|remove|kill|kickstart|stop)\b.*taskboard/i.test(p))
    reasons.push('this stops the Taskboard login service');
  if (/\bdoctor(\.mjs)?\b.*--repair\b/.test(p))
    reasons.push('the doctor repair loads or restarts the Taskboard login service; only the user runs it, from the Taskboard app or Terminal');
}
// A command that only reads files (cat, grep and similar, also joined with |) may name the release, rollback and restart
// scripts, so that a task can read them. It has no ; & $ ` ( ) { } < > or newline, so it cannot start another command.
const readOnly = !/[;&`$<>(){}\n\r]/.test(cmd) && cmd.split('|').every(s => /^\s*(cat|head|tail|grep|egrep|fgrep|wc|nl|ls|stat|file|diff)(\s|$)/.test(s));
// The user approves one release for one task on the dashboard (tb release-request). The approval writes the permit
// release-permits/<task id>.json { taskId, ref, approvedAt, expiresAt } (server/release-permit.ts has the same
// RELEASE_REF). The guard deletes the permit when it lets the release command run, so one permit allows one command.
const RELEASE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const RELEASE_FORMS = '`pnpm release` or `pnpm release --ref <branch, tag or commit>`, each also with `--no-switch` or as `pnpm run release`, alone on the command line (no ;, &&, ||, |, backticks, $( ), quotes, redirects or a second command)';
const releaseText = ref => ref ? `pnpm release --ref ${ref}` : 'pnpm release';
// { ref, noSwitch } for an accepted form of the release command (the options of scripts/release.mjs), or null
function releaseForm(c) {
  if (/[;&|`$<>(){}'"\\\n\r]/.test(c)) return null;
  const w = c.trim().split(/\s+/);
  if (w[0] !== 'pnpm') return null;
  let i = w[1] === 'run' ? 2 : 1;
  if (w[i++] !== 'release') return null;
  let ref = null, noSwitch = false;
  for (; i < w.length; i++) {
    if (w[i] === '--ref' && ref === null && RELEASE_REF.test(w[i + 1] || '')) ref = w[++i];
    else if (w[i] === '--no-switch' && !noSwitch) noSwitch = true;
    else return null;
  }
  return { ref, noSwitch };
}
const clock = ms => new Date(ms).toTimeString().slice(0, 8);
const STOP = 'Do not try another way to run it. Stop and tell the user what this message says';
// '' when the release command may run (the permit is then deleted), otherwise the case and what to do
function releaseRefusal(taskId, now = Date.now()) {
  if (!/^[a-zA-Z0-9_-]+$/.test(taskId) || taskId === 'controller')
    return `a Taskboard release runs only in a Taskboard task that has a release approval, and this session is not such a task. ${STOP}`;
  const file = join(tbDir, 'release-permits', taskId + '.json');
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    if (e?.code === 'ENOENT') return `this task (${taskId}) has no release approval. Run \`tb release-request\` (add \`--ref <branch>\` to release a branch), then wait for the user to approve the card on the dashboard. After the approval, run one of these forms: ${RELEASE_FORMS}`;
    return `the release approval file ${file} cannot be read (${e?.message || e}). ${STOP}`;
  }
  if (data?.taskId !== taskId) return `the release approval file ${file} names task ${data?.taskId}, not this task (${taskId}). ${STOP}`;
  const expiresAt = Number(data.expiresAt);
  if (!(expiresAt > now)) return `the release approval for this task expired at ${clock(expiresAt)} (${Math.round((now - expiresAt) / 1000)} s ago). Run \`tb release-request\` again only if the user still wants the release. ${STOP}`;
  const form = releaseForm(cmd);
  if (!form) return `this command is not an accepted form of the release command. The release approval for this task is valid until ${clock(expiresAt)} and is still unused. Accepted forms: ${RELEASE_FORMS}`;
  // a permit from a server that did not record the ref (no "ref" key) allows each accepted form
  if ('ref' in data && (data.ref ?? null) !== form.ref) return `the user approved \`${releaseText(data.ref ?? null)}\` (valid until ${clock(expiresAt)}, still unused), not \`${releaseText(form.ref)}\`. Run the approved command. For another ref, run \`tb release-request --ref <ref>\` and wait for a new approval`;
  try { unlinkSync(file); } catch (e) { return `the release approval file ${file} could not be deleted (${e?.message || e}), so it could allow a second release. ${STOP}`; }
  return '';
}
// any package manager that runs the release or rollback script (also npm run release, yarn release), or the script file
const release = !readOnly && /\b(pnpm|npm|yarn|bun|npx)\b[^;&|\n]*\srelease\b|\brelease\.mjs\b/.test(cmd);
const rollback = !readOnly && /\b(pnpm|npm|yarn|bun|npx)\b[^;&|\n]*\srollback\b|\brollback\.mjs\b/.test(cmd);
// reasons that are complete without the text about stopping the server
const ownText = [];
if (release) { const why = releaseRefusal(process.env.TASK_ID || ''); if (why) ownText.push(why); }
if (rollback) reasons.push('a Taskboard rollback needs the user to run it');
// Only the user restarts Taskboard. The controller may run `tb restart`: it only puts an Approve card on the dashboard.
if ((!readOnly && /scripts\/restart\.mjs/.test(cmd)) || (process.env.TASK_ID !== 'controller' && /(^|[\s;&|(\/])tb\s+restart\b/.test(cmd)))
  reasons.push('only the user restarts Taskboard, from the dashboard or a terminal');
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
if (reasons.length || ownText.length) {
  const gitOnly = reasons.length === 1 && (reasons[0].startsWith('run `tb git') || reasons[0].startsWith('this task has no worktree'));
  if (gitOnly) ownText.unshift(reasons.pop());
  const stops = [...new Set(reasons)];
  const reason = 'Blocked by Taskboard: ' + [...ownText.map(r => r + '.'), ...(stops.length ? [`${stops.join('; ')}. You are running inside Taskboard, so stopping it would cut off you and every other agent. ` +
      'To stop a test server, kill it by the process id you started it with (for example `... & PID=$!` and later `kill $PID`), or run `pnpm stop` with that server\'s TASKBOARD_DIR set. ' +
      'Test servers must use their own TASKBOARD_PORT, TASKBOARD_DIR, TASKBOARD_VAULT and TASKBOARD_TMUX_SOCKET (see CLAUDE.md in the Taskboard repository).'] : [])].join(' ');
  // agy: no output means "no decision" (the normal approval question follows); so we print only a denial
  process.stdout.write(JSON.stringify(agy ? { decision: 'deny', reason }
    : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
}
process.exit(0);
