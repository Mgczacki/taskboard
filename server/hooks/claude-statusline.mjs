#!/usr/bin/env node
// Claude Code status line for Taskboard sessions. Claude Code passes the session state as JSON on stdin, including
// rate_limits (5-hour and 7-day windows: used_percentage, resets_at). We print a short line for the terminal and
// send the limits to the Taskboard server, which shows them per account. Never fails or waits long.
import { readFileSync } from 'node:fs';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
let j = {}; try { j = JSON.parse(input || '{}'); } catch { /* not JSON */ }
const rl = j.rate_limits || {};
const pct = w => (w && typeof w.used_percentage === 'number' ? `${Math.round(w.used_percentage)}%` : '–');
const parts = [j.model?.display_name, rl.five_hour || rl.seven_day ? `5h ${pct(rl.five_hour)} · week ${pct(rl.seven_day)}` : ''].filter(Boolean);
process.stdout.write(parts.join(' · '));

if (process.env.TASK_ID && (rl.five_hour || rl.seven_day)) {
  try {
    const token = readFileSync(process.env.TB_TOKEN_FILE, 'utf8').trim();
    await fetch(`${process.env.TB_URL}/api/hooks/usage`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-taskboard-token': token },
      body: JSON.stringify({ taskId: process.env.TASK_ID, rate_limits: rl }), signal: AbortSignal.timeout(1500),
    });
  } catch { /* Taskboard not reachable */ }
}
process.exit(0);
