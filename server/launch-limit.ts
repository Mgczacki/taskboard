// A task whose agent reports no credit, a billing problem, a usage limit or an expired sign-in. Codex sends no event
// for a turn that fails this way (tasks 163 and 164 stayed in "working" for 6 minutes), so the watcher (index.ts
// reconcile) reads the screen for the first two minutes after a launch, and the Codex rollout file whenever it changes.
// On such an error: the account gets its limit mark with the agent's text, and the task stops with the reason. A task
// whose account Taskboard chose itself starts once more on the next usable account of the same agent. A task on an
// account that you chose stays there unless automatic moves are enabled in Settings.
import * as machine from './machine.ts';
import { transcriptError } from './agent-errors.ts';
import { moveAfterLimit } from './auto-move.ts';
import { statSync } from 'node:fs';
import * as accounts from './accounts.ts';
import * as agents from './agents.ts';
import * as store from './store.ts';
import * as tmux from './tmux.ts';
import { codexRolloutLimit, limitFromScreen, type LimitHit } from './agent-limits.ts';
import type { Task } from './store.ts';

export const FIRST_OUTPUT_MS = 120000;
const handled = new Map<string, number>();   // task id -> the launch time whose error was handled
export function reset(id: string) { handled.delete(id); rolloutSeen.delete(id); }
const rolloutSeen = new Map<string, number>(); // task id -> the rollout file time read last
const KIND_TEXT = { credit: 'has no credit or has a billing problem', limit: 'reached a usage limit', login: 'is not signed in' } as const;
const clock = () => new Date().toTimeString().slice(0, 5);
const lastLines = (screen: string, n: number) => screen.split('\n').filter(l => l.trim()).slice(-n).join('\n');

// The existing first-start retry applies only before the first completed turn.
const firstStart = (t: Task) => !t.now && Date.now() - Date.parse(t.created) < 10 * 60000;

// Called by the watcher for each task with a live session. True when it found an error (the task is then handled).
export async function check(task: Task): Promise<boolean> {
  const t = { ...task };
  if (t.role === 'controller' || !['working', 'idle', 'unread', 'needs-you', 'stopped'].includes(t.status)) return false;
  const launched = store.launchedAt.get(t.id) || 0;
  if (handled.get(t.id) === launched) return false;
  const early = !!launched && Date.now() - launched < FIRST_OUTPUT_MS;
  // a stopped task is read only right after its launch: a StopFailure hook may have stopped it before this check
  if (t.status === 'stopped' && !early) return false;
  let hit: LimitHit | null = null;
  const enabled = machine.get().accounts.autoMoveOnLimit !== 'off';
  if ((early || (enabled && t.status === 'working')) && !(enabled && t.agent === 'claude' && t.transcript)) hit = limitFromScreen(t.agent, lastLines(await tmux.capture(t.session, 0), 25));
  if (!hit && (t.agent === 'codex' || (enabled && t.agent === 'claude')) && t.transcript) {
    let mtime = 0; try { mtime = statSync(t.transcript).mtimeMs; } catch { /* moved */ }
    if (mtime && rolloutSeen.get(t.id) !== mtime) {
      rolloutSeen.set(t.id, mtime);
      const claude = t.agent === 'claude' ? transcriptError('claude', t.transcript) : null;
      const r = t.agent === 'codex' ? codexRolloutLimit(t.transcript) : claude?.limit ? { kind: claude.limit, text: claude.text, at: claude.at } : null;
      const at = Date.parse(r?.at || '') || 0;
      // only a failure in this launch (after a restart of the server: in the last 10 minutes)
      const afterMove = !t.lastAutoMove || at > Date.parse(t.lastAutoMove.at);
      if (r && afterMove && (launched ? at >= launched - (t.agent === 'claude' ? 0 : 1000) : Date.now() - at < 10 * 60000)) hit = r;
    }
  }
  if (!hit) return false;
  void handle(t, hit, early).catch(e => console.error(`limit check for #${t.num}:`, e));
  return true;
}

// Serialize moves so two failed tasks cannot select the same last slot.
let queue: Promise<void> = Promise.resolve();
export function handle(task: Task, hit: LimitHit, early: boolean): Promise<void> {
  const t = { ...task }, launched = store.launchedAt.get(t.id) || 0;
  const run = queue.then(async () => {
    const current = store.get(t.id);
    if (!current || current.role === 'controller' || current.agent !== t.agent || current.account !== t.account ||
        current.sessionId !== t.sessionId || (store.launchedAt.get(t.id) || 0) !== launched ||
        !['working', 'idle', 'unread', 'needs-you', 'stopped'].includes(current.status) || handled.get(t.id) === launched) return;
    handled.set(t.id, launched);
    await handleCurrent({ ...current }, hit, early);
  });
  queue = run.catch(() => {});
  return run;
}

async function handleCurrent(t: Task, hit: LimitHit, early: boolean) {
  const a = accounts.get(t.account) || accounts.defaultFor(t.agent);
  const reason = `${a.name} ${KIND_TEXT[hit.kind]}: ${hit.text}`;
  if (hit.at && !accounts.reportApplies(a, hit.at)) return;
  if (hit.kind === 'login') await accounts.status(a, true);
  else if (accounts.reportApplies(a, hit.at || new Date().toISOString())) accounts.markLimited(a.id, `${hit.text} (on #${t.num})`);
  if (machine.get().accounts.autoMoveOnLimit !== 'off') {
    if (hit.kind === 'login') { stop(t, reason, 'Sign-in failures do not trigger automatic moves.'); return; }
    store.update(t.id, { status: 'stopped', stopReason: reason.slice(0, 300), statusSource: reason });
    try { await moveAfterLimit(t, reason); }
    catch (e) {
      const current = store.get(t.id);
      // A manual change while sign-in checks waited takes precedence.
      if (current && current.account === t.account && ['stopped', 'suspended'].includes(current.status)) {
        stop(t, reason, `Automatic move stopped: ${e instanceof Error ? e.message : e}`);
      }
    }
    return;
  }
  const first = early ? firstStart(t) : !!hit.neverWorked && firstStart(t);
  // The agent shows a question after such an error (Codex: "Request increase?"). End it, so no typed text answers it.
  if (first) await tmux.killSession(t.session);
  if (first && t.accountChosen === 'auto' && !t.limitRetry) {
    try {
      const next = await accounts.pick(t.agent, agents.runningOn, [a.id]);
      store.update(t.id, { limitRetry: a.id });
      await agents.moveAccount(store.get(t.id)!, next.account.id,
        `The account ${a.name} could not run this task (${hit.text}). Taskboard moved the task to ${next.account.name}. Nothing was done yet: start the task from its original prompt.`, { auto: true });
      const source = `${reason} No account was chosen for this task, so Taskboard started it again on ${next.account.name} at ${clock()}.`;
      store.update(t.id, { statusSource: source });
      store.appendLog(t.id, { did: source, next: 'Continue the task on the new account.' });
      return;
    } catch (e) {
      return stop(t, reason, `Taskboard could not start it on another account: ${e instanceof Error ? e.message : e}`);
    }
  }
  stop(t, reason, t.accountChosen === 'user' ? 'You chose this account, so Taskboard did not move the task.' : '');
}

function stop(t: Task, reason: string, note: string) {
  const cur = store.get(t.id); if (!cur) return;
  const a = accounts.get(cur.account) || accounts.defaultFor(cur.agent);
  const ask = `Move the task to another account, or clear the limit mark on the Accounts page when ${a.name} works again.${accounts.alternatives(a, agents.runningOn)}`;
  store.update(t.id, { status: 'stopped', stopReason: reason.slice(0, 300), ask, statusSource: `Read from the agent at ${clock()}: ${reason}${note ? ` ${note}` : ''}` });
  store.appendLog(t.id, { did: `Stopped: ${reason}${note ? ` ${note}` : ''}`, wait: ask, next: 'Continue when the task has a usable account.' });
}
