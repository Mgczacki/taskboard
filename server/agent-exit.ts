// The reason an agent exited, read from its dead tmux pane. tmux keeps the pane (remain-on-exit) with the last output
// of the agent and its own line "Pane is dead (status N, <time>)".

// An exit within this time after Taskboard started or resumed the agent is a failed start.
export const START_WINDOW_MS = 120000;

// The exit status and the last three non-empty lines of the agent's output, on one line.
export function exitReason(status: number | undefined, screen: string): string {
  const lines = screen.split('\n').map(l => l.trim()).filter(l => l && !/^Pane is dead\b/.test(l));
  const last = lines.slice(-3).join(' ').replace(/\s+/g, ' ').slice(0, 300);
  const code = status === undefined ? 'The agent exited' : `The agent exited with status ${status}`;
  return last ? `${code}: ${last}` : code;
}

export function failedStart(launchedAt: number | undefined, now: number): boolean {
  return !!launchedAt && now - launchedAt < START_WINDOW_MS;
}
