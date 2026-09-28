#!/usr/bin/env node
// Claude Code hook for Taskboard. Claude Code runs this for every hook event listed in ~/.taskboard/claude-settings.json
// and passes the event as JSON on stdin. We forward it to the local Taskboard server.
// The server may answer with JSON for Claude Code (for example a Stop "block" decision); we print it unchanged.
// If anything fails we exit 0 with no output, so the agent is never blocked by Taskboard being down.
import { readFileSync } from 'node:fs';

const taskId = process.env.TASK_ID;
if (!taskId) process.exit(0); // a Claude Code session that Taskboard did not start

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

try {
  const token = readFileSync(process.env.TB_TOKEN_FILE, 'utf8').trim();
  const res = await fetch(`${process.env.TB_URL}/api/hooks/claude`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-taskboard-token': token },
    body: JSON.stringify({ taskId, input: JSON.parse(input || '{}') }),
    signal: AbortSignal.timeout(4000),
  });
  const out = await res.json();
  if (out && out.output) process.stdout.write(JSON.stringify(out.output));
} catch { /* Taskboard not reachable: do nothing */ }
process.exit(0);
