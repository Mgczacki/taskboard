#!/usr/bin/env node
// Stop exactly the Taskboard server of <TASKBOARD_DIR or ~/.taskboard>. The process id comes from server.pid and is
// only used after the server at the recorded address confirms it (its /api/info reports that pid), so a pid left by a
// crashed server and since reused by another program is never signalled.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const dir = process.env.TASKBOARD_DIR || join(homedir(), '.taskboard');
let lock;
try { lock = JSON.parse(readFileSync(join(dir, 'server.pid'), 'utf8')); } catch { console.log(`No server recorded in ${dir}.`); process.exit(0); }
let token = ''; try { token = readFileSync(join(dir, 'token'), 'utf8').trim(); } catch { /* none */ }
const info = await fetch(`${lock.url}/api/info`, { headers: { 'x-taskboard-token': token }, signal: AbortSignal.timeout(3000) }).then(r => r.ok ? r.json() : null).catch(() => null);
if (!info) { console.log(`No Taskboard server answers at ${lock.url}; not signalling process ${lock.pid} (it may belong to another program now).`); process.exit(0); }
if (info.pid !== lock.pid) { console.log(`The server at ${lock.url} is process ${info.pid}, not ${lock.pid} as recorded; not stopping anything.`); process.exit(1); }
process.kill(info.pid, 'SIGTERM');
console.log(`Stopped the Taskboard server (process ${info.pid}). Agents keep running in tmux.${dir === join(homedir(), '.taskboard') ? ' If the login service is installed, launchd starts it again within ~10 s.' : ''}`);
