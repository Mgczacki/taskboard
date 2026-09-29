#!/usr/bin/env node
// Antigravity CLI (agy) hook for Taskboard. The agy plugin "taskboard" runs this for each hook event with the event
// name as the first argument (agy does not put the event name in the payload) and the event as JSON on stdin.
// We forward it to the local Taskboard server and print its answer (for example a Stop "continue" decision).
// agy treats empty output as "no decision" (observed with agy 1.2.12; `{}` from a PreToolUse hook denies the tool call),
// so on any failure we print nothing and the agent is never blocked by Taskboard being down.
import { readFileSync } from 'node:fs';

const taskId = process.env.TASK_ID;
if (!taskId) process.exit(0); // an agy session that Taskboard did not start

const event = process.argv[2];
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

try {
  const token = readFileSync(process.env.TB_TOKEN_FILE, 'utf8').trim();
  const res = await fetch(`${process.env.TB_URL}/api/hooks/antigravity`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-taskboard-token': token },
    body: JSON.stringify({ taskId, event, input: JSON.parse(input || '{}') }),
    signal: AbortSignal.timeout(event === 'PreToolUse' ? 48000 : 4000),
  });
  const out = await res.json();
  if (out && out.output) process.stdout.write(JSON.stringify(out.output));
} catch { /* Taskboard not reachable: do nothing */ }
process.exit(0);
