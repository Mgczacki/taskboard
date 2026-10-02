import type { Account, AccountStatus } from './accounts.ts';
import { unavailable, usageStale } from './accounts.ts';
import { DEFAULT_ROUTING_RULES } from './machine.ts';

export interface ChoiceInput { account: Account; status: AccountStatus; running: number }

// Stale usage data counts as no spare share: unknown, not free.
const spare = (a: Account, label: string) => {
  if (usageStale(a)) return 0;
  const window = a.usage?.windows.find(w => w.label === label && (!w.resetsAt || w.resetsAt > Date.now()));
  return window ? Math.max(0, 100 - window.usedPct) : 0;
};

// All three limits constrain a new task. Compare the smallest spare value first.
export function scoreAccount(a: Account, running: number): [number, number] {
  const values = [spare(a, '5-hour'), spare(a, 'weekly'), 100 * (a.maxParallel - running) / a.maxParallel];
  return [Math.min(...values), values.reduce((x, y) => x + y, 0) / values.length];
}

export function chooseAuto(inputs: ChoiceInput[], task: string, machineRules: string): { account: Account; why: string } {
  if (machineRules.trim() && machineRules.trim() !== DEFAULT_ROUTING_RULES) throw new Error('Auto cannot check the custom machine routing rules. Choose an agent or account directly.');
  const skipped: string[] = [];
  const deep = /\b(deep plan(?:ning)?|plan (?:the |a )?(?:system|architecture|implementation)|architectur\w*|system design)\b/i.test(task);
  const hard = /\b(hard coding|complex coding|complex implementation)\b/i.test(task);
  const restrictAgy = /use claude code or codex for deep planning and hard coding work|do not use (?:it|antigravity) for deep planning/i.test(machineRules);
  const eligible = inputs.filter(({ account: a, status, running }) => {
    const reason = unavailable(a, running);
    if (reason) { skipped.push(reason); return false; }
    if (!status.signedIn) { skipped.push(`${a.id} is not signed in.`); return false; }
    if (a.routingRules?.trim()) { skipped.push(`${a.id} has a routing rule that Auto cannot check.`); return false; }
    if (a.agent === 'antigravity' && restrictAgy && (deep || hard)) { skipped.push(`${a.id} is excluded by the machine routing rule for this task.`); return false; }
    return true;
  });
  if (!eligible.length) throw new Error(`No account can take this task. ${skipped.join(' ')}`);
  eligible.sort((x, y) => {
    const a = scoreAccount(x.account, x.running), b = scoreAccount(y.account, y.running);
    return b[0] - a[0] || b[1] - a[1] || x.account.id.localeCompare(y.account.id);
  });
  const best = eligible[0];
  return { account: best.account, why: `${best.account.agent} on ${best.account.name} (${best.account.id})` };
}
