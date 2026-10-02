#!/usr/bin/env node
// Claude Code hook for Taskboard. Claude Code runs this for every hook event listed in ~/.taskboard/claude-settings.json
// and passes the event as JSON on stdin. We forward it to the local Taskboard server.
// The server may answer with JSON for Claude Code (for example a Stop "block" decision); we print it unchanged.
// If anything fails we exit 0 with no output, so the agent is never blocked by Taskboard being down.
// PermissionRequest waits up to 30 minutes: the server keeps the request open until the user answers the card on the
// Waiting page (server/pending.ts). The dialog stays in the terminal; an answer there makes Claude Code stop this script.
import { readFileSync } from 'node:fs';

const taskId = process.env.TASK_ID;
if (!taskId) process.exit(0); // a Claude Code session that Taskboard did not start

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

try {
  const token = readFileSync(process.env.TB_TOKEN_FILE, 'utf8').trim();
  const event = JSON.parse(input || '{}');
  const hold = event.hook_event_name === 'PermissionRequest';
  const res = await fetch(`${process.env.TB_URL}/api/hooks/claude`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-taskboard-token': token },
    body: JSON.stringify({ taskId, input: event, ...(hold ? { hold: true } : {}) }),
    signal: AbortSignal.timeout(hold ? 1_790_000 : 4000),
  });
  const out = await res.json();
  if (out && out.output) process.stdout.write(JSON.stringify(out.output));
} catch { /* Taskboard not reachable: do nothing */ }
process.exit(0);
