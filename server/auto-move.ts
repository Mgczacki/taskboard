import * as accounts from './accounts.ts';
import * as agents from './agents.ts';
import * as machine from './machine.ts';
import * as store from './store.ts';
import { chooseAuto, type ChoiceInput } from './auto-choice.ts';
import type { Task } from './store.ts';

// Reuse the routing rules for Auto, but require recent usage for every automatic replacement.
export function chooseLimitTarget(inputs: ChoiceInput[], task: Task, mode: machine.AutoMoveOnLimit, rules: string) {
  if (mode === 'off') throw new Error('Automatic moves are off.');
  const excluded = new Set([task.account || accounts.defaultFor(task.agent).id, ...(task.autoMoveAttempts || [])]);
  const eligible = inputs.filter(x => !excluded.has(x.account.id) && !accounts.usageStale(x.account) &&
    !x.account.usage?.windows.some(w => w.usedPct >= 100 && (!w.resetsAt || w.resetsAt > Date.now())) &&
    (!task.computerUse || x.account.agent !== 'antigravity'));
  const context = `${task.title}\n${task.desc}`;
  try {
    return chooseAuto(eligible.filter(x => x.account.agent === task.agent), context, rules);
  } catch (sameError) {
    if (mode === 'same-kind') throw sameError;
    return chooseAuto(eligible.filter(x => x.account.agent !== task.agent), context, rules);
  }
}

export async function moveAfterLimit(t: Task, reason: string): Promise<void> {
  const from = accounts.get(t.account) || accounts.defaultFor(t.agent);
  accounts.refreshCodexUsage();
  const inputs = await Promise.all(accounts.all().filter(a => a.id !== from.id && !accounts.usageStale(a) && !accounts.unavailable(a, agents.runningOn(a.id))).map(async account => ({
    account, status: await accounts.status(account), running: agents.runningOn(account.id),
  })));
  const current = store.get(t.id);
  if (!current || current.account !== t.account || current.sessionId !== t.sessionId || current.status !== 'stopped') throw new Error('The task changed while choosing an account.');
  const settings = machine.get();
  let to: accounts.Account;
  try { to = chooseLimitTarget(inputs, t, settings.accounts.autoMoveOnLimit, settings.routingRules).account; }
  catch (e) { throw new Error(`${e instanceof Error ? e.message : e} Automatic moves also exclude attempted accounts and STALE or missing usage data.`); }
  const attempted = [...new Set([...(t.autoMoveAttempts || []), from.id, to.id])];
  store.update(t.id, { autoMoveAttempts: attempted });
  const notice = { at: new Date().toISOString(), from: `${from.name} (${from.id})`, to: `${to.name} (${to.id})`, reason };
  await agents.moveAccount(t, to.id, `Taskboard moved this task because ${reason}. Continue from the last unfinished step.`, {
    auto: true,
    beforeStop: () => {
      // Sign-in checks can wait. Recheck settings and capacity immediately before ending the old process.
      const current = store.get(t.id);
      if (!current || current.account !== t.account || current.sessionId !== t.sessionId || current.status !== 'stopped') throw new Error('The task changed while choosing an account.');
      chooseLimitTarget([{ account: to, status: { signedIn: true, checkedAt: Date.now() }, running: agents.runningOn(to.id) }],
        { ...current, autoMoveAttempts: attempted.filter(id => id !== to.id) }, machine.get().accounts.autoMoveOnLimit, machine.get().routingRules);
      const refused = accounts.refusal(to, agents.runningOn(to.id), agents.runningOn);
      if (refused) throw new Error(refused);
    },
  });
  const text = `Automatic move from ${notice.from} to ${notice.to}. Reason: ${reason}`;
  store.update(t.id, { lastAutoMove: notice, statusSource: text });
  store.appendLog(t.id, { did: text, next: 'Continue the task on the new account.' });
}
