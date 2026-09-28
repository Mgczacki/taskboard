#!/usr/bin/env node
// Codex "notify" program for Taskboard. Codex runs it at the end of every turn with one JSON argument
// (type "agent-turn-complete", thread-id, last-assistant-message, ...). We forward it to the Taskboard server,
// then run the notify program you had configured before (for example Computer Use), so it keeps working.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const payload = process.argv[process.argv.length - 1];

const orig = process.env.TB_CODEX_ORIG_NOTIFY;
if (orig) {
  try {
    const cmd = JSON.parse(orig);
    if (Array.isArray(cmd) && cmd.length) spawn(cmd[0], [...cmd.slice(1), payload], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* ignore */ }
}

const taskId = process.env.TASK_ID;
if (taskId) {
  try {
    const token = readFileSync(process.env.TB_TOKEN_FILE, 'utf8').trim();
    await fetch(`${process.env.TB_URL}/api/hooks/codex`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-taskboard-token': token },
      body: JSON.stringify({ taskId, payload: JSON.parse(payload) }),
      signal: AbortSignal.timeout(4000),
    });
  } catch { /* Taskboard not reachable */ }
}
process.exit(0);
