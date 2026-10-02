// One-step restart of this Taskboard server (scripts/restart.mjs does the work).
// - impact(): what a restart does to running tasks, for GET /api/restart/check, the dashboard and the controller card.
// - startRestart(): runs scripts/restart.mjs --yes as its own process, so the script keeps running when it stops this
//   server. Its output goes to TB_DIR/restart.log and its result to TB_DIR/restart-result.json.
// Agent sessions live in a tmux server (socket TMUX_SOCKET), which is a separate process and keeps running. Work that
// lives in this process is lost: Ask answers, the results of running permit commands, account moves in progress, and
// pending approval cards.
import { execFile, spawn } from 'node:child_process';
import { openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ROOT, TB_DIR } from './config.ts';
import type { Task } from './store.ts';
import * as tmux from './tmux.ts';

const exec = promisify(execFile);

export interface RestartStop { num: number; title: string; what: string }
export interface RestartImpact {
  sessions: { num: number; title: string; status: string }[]; // agent sessions that run in tmux now
  stops: RestartStop[];  // work that a restart stops; the user must confirm
  notes: string[];       // other effects, no confirmation
  tmuxPid?: number;
  tmuxStops: boolean;    // the tmux server is in this server's process group, so it can stop with it
}

export interface ImpactInput {
  tasks: Task[];
  liveSessions: string[];        // tmux session names with a live pane
  askRunning: string[];          // task ids with a running Ask question
  permitsRunning: { taskId: string; id: string }[];
  moving: string[];              // task ids in an account move
  pendingApprovals: number;
  tmuxPid?: number;
  tmuxGroup?: number;            // process group of the tmux server
  ownGroup?: number;             // process group of this server
}

export function restartImpact(i: ImpactInput): RestartImpact {
  const byId = new Map(i.tasks.map(t => [t.id, t]));
  const live = new Set(i.liveSessions);
  const label = (t: Task) => t.role === 'controller' ? 'controller' : t.title;
  const sessions = i.tasks.filter(t => t.status !== 'archived' && live.has(t.session)).map(t => ({ num: t.num, title: label(t), status: t.status }));
  const tmuxStops = !!i.tmuxGroup && i.tmuxGroup === i.ownGroup;
  const stops: RestartStop[] = [];
  const add = (id: string, what: string) => { const t = byId.get(id); stops.push({ num: t?.num ?? 0, title: t ? label(t) : id, what }); };
  if (tmuxStops) for (const t of i.tasks.filter(t => t.status !== 'archived' && live.has(t.session))) add(t.id, 'its agent session can stop with Taskboard');
  for (const id of i.askRunning) add(id, 'the answer to the running BTW question is lost');
  for (const p of i.permitsRunning) add(p.taskId, `permit ${p.id} keeps running, but Taskboard records its result as unknown`);
  for (const id of i.moving) add(id, 'the move to another account is cut off; check the task after the restart');
  for (const t of i.tasks) if (t.transfer?.state === 'starting') add(t.id, 'the transfer to another machine is cut off; check the task after the restart');
  const notes: string[] = [];
  if (i.pendingApprovals) notes.push(`${i.pendingApprovals} approval card${i.pendingApprovals === 1 ? '' : 's'} on the dashboard expire${i.pendingApprovals === 1 ? 's' : ''}. Nothing runs, and the agents ask again.`);
  notes.push('Status updates that agents send during the restart are not received. The new server reads each task again from tmux and the transcripts.');
  return { sessions, stops, notes, tmuxPid: i.tmuxPid, tmuxStops };
}

const groupOf = async (pid: number) => { try { return Number((await exec('ps', ['-o', 'pgid=', '-p', String(pid)])).stdout.trim()) || undefined; } catch { return undefined; } };

// The tmux server's process id and process group, if it runs.
export async function tmuxProcess(): Promise<{ pid?: number; group?: number }> {
  let pid: number | undefined;
  try { pid = Number((await tmux.tmux('display-message', '-p', '#{pid}')).trim()) || undefined; } catch { return {}; }
  return { pid, group: pid ? await groupOf(pid) : undefined };
}
export const ownGroup = () => groupOf(process.pid);

// Start scripts/restart.mjs as its own process (detached: a new session and process group, so neither launchd nor
// this server's exit stops it). TASK_ID is removed: the script refuses to run for a task.
export function startRestart(): number {
  const out = openSync(join(TB_DIR, 'restart.log'), 'a');
  const env = { ...process.env }; delete env.TASK_ID;
  const p = spawn(process.execPath, [join(ROOT, 'scripts', 'restart.mjs'), '--yes'], { cwd: ROOT, env, detached: true, stdio: ['ignore', out, out] });
  p.unref();
  return p.pid || 0;
}

export function lastResult(): unknown {
  try { return JSON.parse(readFileSync(join(TB_DIR, 'restart-result.json'), 'utf8')); } catch { return null; }
}
