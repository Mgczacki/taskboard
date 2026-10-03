#!/usr/bin/env node
// Codex hook for the Taskboard controller (agents.ts CODEX_CONTROLLER_HOOKS: UserPromptSubmit, PostToolUse and Stop).
// Codex passes the event as JSON on stdin with hook_event_name, as Claude Code does. We forward it to the local
// Taskboard server and print its answer unchanged (additionalContext, or a Stop "block" decision).
// If anything fails we exit 0 with no output, so the agent is never blocked by Taskboard being down.
import { readFileSync } from 'node:fs';

const taskId = process.env.TASK_ID;
if (!taskId) process.exit(0); // a Codex session that Taskboard did not start

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

try {
  const token = readFileSync(process.env.TB_TOKEN_FILE, 'utf8').trim();
  const res = await fetch(`${process.env.TB_URL}/api/hooks/codex-hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-taskboard-token': token },
    body: JSON.stringify({ taskId, input: JSON.parse(input || '{}') }),
    signal: AbortSignal.timeout(8000),
  });
  const out = await res.json();
  if (out && out.output) process.stdout.write(JSON.stringify(out.output));
} catch { /* Taskboard not reachable: do nothing */ }
process.exit(0);
