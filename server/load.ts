// Memory of the running agents, for the note on the Accounts page. Nothing here limits or blocks a start.
// Each agent is a tmux pane; its memory is the resident memory (RSS) of the pane's process and all processes below it
// (the CLI, its MCP servers, and the commands it runs at that moment).
import { execFile } from 'node:child_process';
import { totalmem } from 'node:os';
import { promisify } from 'node:util';
import * as tmux from './tmux.ts';

const exec = promisify(execFile);
// Measured on a 64 GB Mac with 15 agents (2026-09-29): an idle Claude Code session used 300–440 MB with its MCP
// servers, an idle Codex session 360–630 MB. 500 MB is the planning figure for one agent.
export const AGENT_MB = 500;
// The note shows when the agents would use more than a quarter of the memory at AGENT_MB each. The rest stays for
// the builds and tests the agents start (one Codex test run used 7.8 GB), the browser and the system.
export const noteAbove = (memBytes = totalmem()) => Math.max(1, Math.floor(memBytes * 0.25 / (AGENT_MB * 1024 * 1024)));

export interface AgentLoad { agents: number; medianMb: number; totalMb: number; memMb: number; noteAbove: number }

// Sum the RSS (in KB, as ps prints it) of each root process and its descendants.
export function treeKb(ps: string, roots: number[]): number[] {
  const rss = new Map<number, number>(), kids = new Map<number, number[]>();
  for (const line of ps.split('\n')) {
    const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number);
    if (!pid) continue;
    rss.set(pid, kb || 0); kids.set(ppid, [...(kids.get(ppid) || []), pid]);
  }
  return roots.map(root => {
    let sum = 0; const todo = [root], seen = new Set<number>();
    while (todo.length) { const p = todo.pop()!; if (seen.has(p)) continue; seen.add(p); sum += rss.get(p) || 0; todo.push(...(kids.get(p) || [])); }
    return sum;
  });
}

let cache: { at: number; value: AgentLoad } | undefined;
// sessions: the tmux session names of the tasks that run now (the controller included)
export async function agentLoad(sessions: string[]): Promise<AgentLoad> {
  if (cache && Date.now() - cache.at < 30000) return cache.value;
  const names = new Set(sessions);
  const panes = ((await tmux.listSessions()) || []).filter(s => names.has(s.name) && !s.dead);
  let sizes: number[] = [];
  if (panes.length) {
    try { sizes = treeKb((await exec('ps', ['-axo', 'pid=,ppid=,rss='])).stdout, panes.map(p => p.panePid)).map(kb => kb / 1024); }
    catch { /* ps failed: report the count only */ }
  }
  const sorted = [...sizes].sort((a, b) => a - b);
  const value = {
    agents: panes.length,
    medianMb: sorted.length ? Math.round(sorted[Math.floor((sorted.length - 1) / 2)]) : 0,
    totalMb: Math.round(sizes.reduce((a, b) => a + b, 0)),
    memMb: Math.round(totalmem() / 1024 / 1024),
    noteAbove: noteAbove(),
  };
  cache = { at: Date.now(), value };
  return value;
}
