#!/usr/bin/env node
// Antigravity CLI (agy) status line command for Taskboard. agy passes its state as JSON on stdin, including `quota`:
// one entry per quota bucket (for example "gemini-weekly") with remaining_fraction and reset_time. In a Taskboard
// session we send the quota to the Taskboard server, which shows it on the account. We print nothing: the command is
// set with stack_with_default, so agy's own status line stays as it is. Never fails or waits long.
import { readFileSync } from 'node:fs';

if (!process.env.TASK_ID) process.exit(0); // an agy session that Taskboard did not start
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
let j = {}; try { j = JSON.parse(input || '{}'); } catch { /* not JSON */ }
if (j.quota && typeof j.quota === 'object' && Object.keys(j.quota).length) {
  try {
    const token = readFileSync(process.env.TB_TOKEN_FILE, 'utf8').trim();
    await fetch(`${process.env.TB_URL}/api/hooks/agy-usage`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-taskboard-token': token },
      body: JSON.stringify({ taskId: process.env.TASK_ID, quota: j.quota, plan: j.plan_tier }), signal: AbortSignal.timeout(1500),
    });
  } catch { /* Taskboard not reachable */ }
}
process.exit(0);
