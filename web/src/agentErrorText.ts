// The words that the dashboard shows for a model or API error of a task (server/agent-error-watch.ts sets
// Task.agentError and Task.errorLabel). Observed errors (the hook, the session file, the screen) and the inferred stall
// get different words, so the text never says more than Taskboard saw.
import type { AgentError, Task } from './api';

const MAX_TRIES = 5; // server/agent-errors.ts MAX_TRIES
const clock = (iso?: string) => iso ? new Date(iso).toTimeString().slice(0, 5) : '';
const SOURCE: Record<AgentError['source'], string> = {
  hook: 'Claude Code reported it (StopFailure hook)', transcript: 'read from the session file', screen: 'read from the screen',
  stall: 'inferred: no change on the screen or in the transcript',
};

// 'retrying' (calm color), 'stopped' (an error that needs you or auto-continue), or null when nothing shows
export function errorTone(t: Pick<Task, 'errorLabel' | 'agentError' | 'status'>): 'retrying' | 'stopped' | null {
  if (!t.errorLabel || !t.agentError) return null;
  return t.status === 'stopped' ? 'stopped' : 'retrying';
}

// One line for a tooltip or the Waiting page: the label, the agent's text, the time and where it came from.
export function errorDetail(e: AgentError): string {
  const attempt = e.attempt ? ` Attempt ${e.attempt}${e.maxAttempts ? ` of ${e.maxAttempts}` : ''}${e.retryIn ? `, next in ${e.retryIn}` : ''}.` : '';
  return `${e.text.replace(/\.$/, '')}.${attempt} ${clock(e.at || e.seen)}, ${SOURCE[e.source]}.`;
}

// What Taskboard did or will do, for the banner of a stopped task.
export function autoText(t: Pick<Task, 'agentError' | 'autoContinueOn'>, message: string): string {
  const e = t.agentError; if (!e) return '';
  const tries = e.auto?.tries || 0;
  if (!['overloaded', 'rate_limited', 'server_error', 'network'].includes(e.kind))
    return e.kind === 'stalled' ? 'The agent may still run. Look at the terminal before you continue.' : 'Auto-continue does not retry this kind of error: it needs you.';
  if (e.auto?.off) return `Auto-continue stopped${tries ? ` after ${tries} ${tries === 1 ? 'try' : 'tries'}` : ''}: ${e.auto.off}`;
  if (!t.autoContinueOn) return 'Auto-continue is off for this task.';
  if (e.auto?.nextAt) return `Taskboard types "${message}" at ${clock(e.auto.nextAt)} (try ${tries + 1} of ${e.auto.maxTries || MAX_TRIES}; ${Math.max(0, (e.auto.maxTries || MAX_TRIES) - tries)} left)${e.auto.wait ? `. Waits: ${e.auto.wait}` : ''}.`;
  return '';
}

// Several tasks of one account with an overloaded model or a server error in the last 15 minutes: one banner line for
// each account, as server/agent-error-watch.ts health() counts them for tb accounts. It is a passing note, not a limit.
export function overloadBanners(tasks: Task[], now = Date.now()): { account: string; text: string; tasks: number[] }[] {
  const by = new Map<string, Task[]>();
  for (const t of tasks) {
    const e = t.agentError;
    if (!e || !t.errorLabel || t.status === 'archived' || !['overloaded', 'server_error'].includes(e.kind) || e.phase === 'resumed') continue;
    if (now - Date.parse(e.seen) > 15 * 60000) continue;
    const id = t.account || `${t.agent}-default`;
    by.set(id, [...(by.get(id) || []), t]);
  }
  return [...by.entries()].filter(([, ts]) => ts.length >= 2).map(([account, ts]) => {
    const agent = ts[0].agent === 'codex' ? 'Codex' : ts[0].agent === 'antigravity' ? 'Antigravity' : 'Claude';
    const nums = ts.map(t => t.num).sort((a, b) => a - b);
    return { account, tasks: nums, text: `${agent} model overloaded: ${ts.length} tasks affected (${nums.map(n => `#${n}`).join(', ')}) on ${account}.` };
  });
}
