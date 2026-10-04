// Is the working directory of the tmux server (tmux -L <TMUX_SOCKET>) a deleted folder? On 4 October 2026 a release
// removed the release folder that the tmux server ran from. tmux then started each new pane in the deleted folder,
// and no task could start or resume. Taskboard now starts tmux from the home folder (tmux.ts) and each pane changes
// to its own folder first (inFolder), but a tmux server that started before that keeps its folder until it ends.
// The server checks at start and every minute. /api/info carries the result, and the dashboard and tb info show it.
// A running process cannot be moved to another folder from outside, so the only repair is a restart of the tmux
// server, which ends every task session. The text gives the command and the tasks that run now.
import { tmuxFolderProblem, tmuxRestartCommand, tmuxServerFolder, type TmuxServerFolder } from '../scripts/cwd-check.mjs';
import { TMUX_SOCKET } from './config.ts';
import { TMUX_BIN, listSessions } from './tmux.ts';

export interface TmuxHealth extends TmuxServerFolder { problem: string; command: string; sessions: string[]; checkedAt: string }
let last: TmuxHealth | null = null;

export async function check(): Promise<TmuxHealth | null> {
  const s = await tmuxServerFolder(TMUX_SOCKET, TMUX_BIN).catch(() => null);
  const problem = tmuxFolderProblem(s, TMUX_SOCKET, TMUX_BIN);
  const sessions = problem ? ((await listSessions()) || []).filter(x => !x.dead).map(x => x.name) : [];
  last = s && problem ? { ...s, problem, command: tmuxRestartCommand(TMUX_SOCKET, TMUX_BIN), sessions: [...new Set(sessions)], checkedAt: new Date().toISOString() } : null;
  return last;
}

export const current = () => last;

export function start() {
  const run = async () => { const before = last?.pid; await check(); if (last && last.pid !== before) console.error(last.problem); };
  void run();
  setInterval(run, 60_000).unref();
}
