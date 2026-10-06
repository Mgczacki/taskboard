import type { Agent, Task } from './store.ts';

export interface FailureAccount {
  account?: string;
  name?: string;
  agent: Agent;
  reason: string;
  at?: string;
}

// Older tasks have no saved failure account. A move entry names the account that ran the task before it moved.
export function failureAccountFromLog(log: string): FailureAccount | undefined {
  let reason: string | undefined;
  let failure: FailureAccount | undefined;
  for (const line of log.split('\n')) {
    const stop = line.match(/^- Did: Stopped: (.+)$/);
    if (stop) { reason = stop[1]; failure = undefined; continue; }
    if (!reason) continue;
    const move = line.match(/^- Did: Moved from (.+) \((claude|codex|antigravity)\) to /);
    if (move) { failure = { name: move[1], agent: move[2] as Agent, reason }; reason = undefined; }
  }
  return failure;
}

export function failureAccountOnStop(task: Pick<Task, 'account' | 'agent'>, reason: string): FailureAccount {
  return { account: task.account || `${task.agent}-default`, agent: task.agent, reason, at: new Date().toISOString() };
}

export function failureAccountAfterMove(failure: FailureAccount | undefined, from: { id: string; name: string }): FailureAccount | undefined {
  return failure?.account === from.id && !failure.name ? { ...failure, name: from.name } : failure;
}
