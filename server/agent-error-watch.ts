// Shows on a task when its agent stopped on a model or API error, or when it retries one, and types the auto-continue
// message when Settings allows it. The rules (patterns, stall rule, state changes, auto-continue decisions) are in
// agent-errors.ts; this file reads the sources and writes the task.
//
// Sources, in the order of trust:
// 1. Claude Code StopFailure hook (events.ts calls stopFailure): exact, fires once after Claude Code gave up.
// 2. The transcript: the Claude Code transcript (an isApiErrorMessage record) or the Codex rollout file (a failed
//    task_complete). Read only when the file time changed, from its last 256 KB.
// 3. The screen: retries ("attempt 3/10", "Reconnecting... 2/5") of a working task, and the Codex "■" error line when
//    the rollout file is not known. Read at most every SCREEN_MS for each working task.
// 4. The stall rule: a working task that waits for the model and whose screen and transcript did not change for the
//    stall time (Settings, default 5 minutes). This one is inferred, and the text says so.
// A stop sets the status "stopped" with Task.agentError; a retry keeps "working" and only sets Task.agentError. A turn
// that ends without an error clears it (events.ts calls turnEnded).
import { statSync } from 'node:fs';
import * as store from './store.ts';
import type { Task } from './store.ts';
import * as accounts from './accounts.ts';
import * as machine from './machine.ts';
import * as tmux from './tmux.ts';
import * as pending from './pending.ts';
import * as external from './external.ts';
import * as managerEvents from './manager-events.ts';
import { deliverText } from './deliver-text.ts';
import { boxState, type PromptAgent } from './type-command.ts';
import {
  applyHit, claudeKind, CONTINUABLE, continueDecision, errorFromScreen, isCodexCapacity, kindLabel, MAX_TRIES, nextDue, screenSignature, shortLabel, stalled,
  transcriptError, type AgentError, type ErrorHit,
} from './agent-errors.ts';

// tests set shorter times: TASKBOARD_ERROR_SCREEN_MS for the screen reads, TASKBOARD_STALL_MS for the stall time
export const SCREEN_MS = Number(process.env.TASKBOARD_ERROR_SCREEN_MS) || 10000;
const stallMs = () => Number(process.env.TASKBOARD_STALL_MS) || machine.get().agentErrors.stallMinutes * 60000;
const clock = (ms = Date.now()) => new Date(ms).toTimeString().slice(0, 5);
const SOURCE_TEXT = { hook: 'Claude Code StopFailure hook', transcript: 'the session file', screen: 'the screen', stall: 'no activity' } as const;

// in memory: for each task, when the screen was last read and when its text (without timers) last changed
const screens = new Map<string, { readAt: number; sig: string; changedAt: number }>();
// tasks that Taskboard typed the auto-continue message into, with the time and the text
const typed = new Map<string, { at: number; text: string }>();
export function forget(id: string) { screens.delete(id); typed.delete(id); }

export function autoContinueOn(t: Pick<Task, 'autoContinue' | 'account' | 'agent'>): boolean {
  if (t.autoContinue) return t.autoContinue === 'on';
  const s = machine.get().agentErrors;
  const acc = s.accounts[t.account || accounts.defaultFor(t.agent)?.id || ''];
  return acc ? acc === 'on' : s.autoContinue;
}
function policy(t: Task, hit: ErrorHit) {
  if (isCodexCapacity(t.agent, hit)) {
    const c = machine.get().agentErrors.codexCapacity;
    return { enabled: c.enabled, schedule: { intervalMs: c.intervalSeconds * 1000, maxTries: c.maxRetries } };
  }
  return { enabled: autoContinueOn(t), schedule: undefined };
}
export function errorAutoContinueOn(t: Task): boolean { return t.agentError ? policy(t, t.agentError).enabled : autoContinueOn(t); }

function describe(e: AgentError): string {
  const attempt = e.attempt ? ` (attempt ${e.attempt}${e.maxAttempts ? `/${e.maxAttempts}` : ''})` : '';
  return e.kind === 'stalled' ? e.text : `${e.text}${attempt}`;
}
function plan(e: AgentError, t: Task): string {
  if (!['overloaded', 'rate_limited', 'server_error', 'network'].includes(e.kind)) return '';
  if (!policy(t, e).enabled) return ' Auto-continue is off.';
  if (e.auto?.off) return ` Auto-continue stopped: ${e.auto.off}`;
  return e.auto?.nextAt ? ` Taskboard types "${machine.get().agentErrors.message}" at ${clock(Date.parse(e.auto.nextAt))} (try ${(e.auto.tries || 0) + 1} of ${e.auto.maxTries || MAX_TRIES}).` : '';
}

// The label that lists show (tb list, the task row), or '': an error shows on a stopped task, and a retry or an
// auto-continue on a working one. After a resume or a move the old error no longer applies.
export function errorLabel(t: Task): string {
  const e = t.agentError;
  if (!e) return '';
  if (t.status === 'stopped' ? e.phase !== 'stopped' : t.status !== 'working' || e.phase === 'stopped') return '';
  return shortLabel(e);
}

// Record a stop: status "stopped", the reason, the task log, and an event for a group manager.
export function stop(t: Task, hit: ErrorHit) {
  const cur = store.get(t.id); if (!cur || ['archived', 'parked', 'suspended'].includes(cur.status)) return;
  if (cur.status === 'stopped' && cur.agentError?.phase === 'stopped' && cur.agentError.text === hit.text) return;
  const p = policy(cur, hit);
  const previous = cur.agentError && isCodexCapacity(cur.agent, cur.agentError) === isCodexCapacity(cur.agent, hit) ? cur.agentError : undefined;
  const e = applyHit(previous, hit, Date.now(), p.enabled, p.schedule);
  if (e.auto && !e.auto.session) e.auto = { ...e.auto, account: cur.account, model: cur.model, session: cur.session };
  const label = shortLabel(e);
  const observed = hit.source === 'stall' ? 'Inferred from' : 'Read from';
  const source = `${observed} ${SOURCE_TEXT[hit.source]} at ${clock()}: ${describe(e)}.${plan(e, cur)}`;
  store.update(t.id, {
    status: 'stopped', agentError: e, stopReason: `${label}: ${describe(e)}`.slice(0, 300), ask: '',
    errorSeenAt: hit.at || cur.errorSeenAt, statusSource: source.slice(0, 500),
  });
  store.appendLog(t.id, { did: `${label}. ${source}`, wait: e.kind === 'stalled' ? 'The user: look at the terminal, then use Continue or Dismiss.' : 'The user: use Continue, or wait for auto-continue when it is on.', next: 'Continue when the model answers again.' });
  managerEvents.record(t.id, 'agent_error', `${label}: ${describe(e)}${hit.source === 'stall' ? ' (inferred)' : ''}`, true);
  noteOverload();
}

// A retry that the agent shows on its screen. The task keeps "working".
function retrying(t: Task, hit: ErrorHit) {
  const prev = t.agentError;
  if (prev?.phase === 'retrying' && prev.attempt === hit.attempt && prev.text === hit.text) return;
  const p = policy(t, hit);
  const e = applyHit(prev, hit, Date.now(), p.enabled, p.schedule);
  store.update(t.id, { agentError: e, statusSource: `Read from the screen at ${clock()}: the agent retries after ${kindLabel(e)} (${describe(e)}).` });
  // one log line for each episode, not one for each attempt
  if (prev?.phase !== 'retrying') store.appendLog(t.id, { did: `The agent retries by itself after an error: ${describe(e)}.`, next: 'Nothing: the agent retries on its own.' });
  noteOverload();
}

// A turn ended without an error (Claude Code Stop hook, Codex agent-turn-complete with no error): the episode ends.
export function turnEnded(t: Task): Partial<Task> {
  typed.delete(t.id);
  if (!t.agentError) return {};
  store.appendLog(t.id, { did: `Recovered: the agent finished a turn after ${kindLabel(t.agentError)}${t.agentError.auto?.tries ? ` and ${t.agentError.auto.tries} auto-continue message${t.agentError.auto.tries === 1 ? '' : 's'}` : ''}.` });
  return { agentError: undefined };
}

// A prompt reached the agent (UserPromptSubmit). The text that Taskboard typed keeps the episode open ("resumed"),
// so its tries add up. Any other prompt is a person or another message: the error no longer applies.
export function promptSubmitted(t: Task, prompt: string | undefined): Partial<Task> {
  if (!t.agentError) return {};
  const mine = typed.get(t.id);
  if (mine && Date.now() - mine.at < 120000 && (prompt === undefined || prompt.trim() === mine.text.trim()))
    return { agentError: { ...t.agentError, phase: 'resumed' } };
  typed.delete(t.id);
  return { agentError: undefined };
}

// Claude Code StopFailure hook. Returns false for a credit or usage limit, which events.ts handles as before.
export function stopFailure(t: Task, input: { error?: string; error_details?: string; last_assistant_message?: string }): boolean {
  const text = String(input.last_assistant_message || input.error_details || input.error || 'API error').replace(/\s+/g, ' ').trim().slice(0, 200);
  const kind = claudeKind(String(input.error || ''), text);
  if (kind === 'limit' || kind === 'credit') return false;
  stop(t, { kind, text, source: 'hook', at: new Date().toISOString() });
  return true;
}

// The newest error time that was handled for this task: an error record at or before it is not read again.
const handledUntil = (t: Task) => Math.max(Date.parse(t.errorSeenAt || '') || 0, Date.parse(t.agentError?.at || '') || 0);
// only an error of this launch counts (after a server restart: of the last 10 minutes)
function thisLaunch(t: Task, at: number) {
  const launched = store.launchedAt.get(t.id) || 0;
  return launched ? at >= launched - 1000 : Date.now() - at < 10 * 60000;
}

// Called by the watcher (index.ts reconcile) for each task with a live session, every 2 s.
// readScreen returns the visible screen (cached by window activity in index.ts).
export async function check(t: Task, readScreen: () => Promise<string>): Promise<void> {
  if (t.role === 'controller' || t.agent === 'antigravity') return;
  if (!['working', 'idle', 'unread', 'stopped'].includes(t.status)) return;
  const now = Date.now();
  let mtime = 0;
  try { if (t.transcript) mtime = statSync(t.transcript).mtimeMs; } catch { /* moved */ }

  // 2. the transcript, when it changed after the last read
  const seenFile = lastFile.get(t.id);
  if (t.transcript && mtime && seenFile !== mtime) {
    lastFile.set(t.id, mtime);
    const hit = transcriptError(t.agent, t.transcript);
    const at = Date.parse(hit?.at || '') || 0;
    if (hit && !hit.limit && at > handledUntil(t) && thisLaunch(t, at)) {
      // the hook already reported this stop (Claude Code); the record time is a little before the hook time
      if (!(t.status === 'stopped' && t.agentError?.phase === 'stopped')) { stop(t, hit); return; }
      store.update(t.id, { errorSeenAt: hit.at });
    }
    // a new turn after the error: a Codex task that someone continued, or that Taskboard continued
    if (!hit && t.status === 'stopped' && t.agentError && t.agent === 'codex' && mtime > Date.parse(t.agentError.seen) + 1500) {
      const r = external.readState('codex', t.transcript);
      if (r && (r.state === 'busy' || r.state === 'tool')) {
        const patch = promptSubmitted(t, typed.get(t.id)?.text);
        store.update(t.id, { status: 'working', ...patch, statusSource: `A new Codex turn started at ${clock()} after the error.` });
        return;
      }
    }
  }

  // stalled: activity again ends it (the screen or the transcript changed)
  const cur = store.get(t.id)!;
  if (cur.status === 'stopped' && cur.agentError?.kind === 'stalled') {
    const sig = screenSignature(await readScreen());
    const s = screens.get(t.id);
    if (mtime > Date.parse(cur.agentError.seen) || (s && s.sig !== sig)) {
      screens.set(t.id, { readAt: now, sig, changedAt: now });
      store.update(t.id, { status: 'working', agentError: undefined, stopReason: undefined, statusSource: `Activity again at ${clock()} after the stall.` });
      store.appendLog(t.id, { did: 'The stalled agent shows activity again.' });
    }
    return;
  }
  if (cur.status !== 'working') return;

  // 3. the screen, at most every SCREEN_MS
  const s = screens.get(t.id);
  if (s && now - s.readAt < SCREEN_MS) return;
  const screen = await readScreen();
  const sig = screenSignature(screen);
  screens.set(t.id, { readAt: now, sig, changedAt: !s || s.sig !== sig ? now : s.changedAt });
  const hit = errorFromScreen(t.agent, screen);
  const after = store.get(t.id)!;
  if (hit?.retrying) { retrying(after, hit); return; }
  // the Codex "■" line: only without a rollout file, which is exact and is read above
  if (hit && !t.transcript) { stop(after, { ...hit, at: new Date().toISOString() }); return; }
  // the retry is gone from the screen and the agent did not stop: it got an answer
  if (after.agentError?.phase === 'retrying') {
    const back = after.agentError.auto?.tries ? { agentError: { ...after.agentError, phase: 'resumed' as const, attempt: undefined, retrying: undefined } } : { agentError: undefined };
    store.update(t.id, { ...back, statusSource: `The retry ended at ${clock()}; the agent works again.` });
    return;
  }

  // 4. the stall rule
  const limitMs = stallMs();
  if (!limitMs) return;
  const quietMs = now - Math.max(screens.get(t.id)!.changedAt, mtime, Date.parse(after.statusAt) || 0, store.launchedAt.get(t.id) || 0);
  if (quietMs < limitMs) return;
  const state = t.transcript ? external.readState(t.agent, t.transcript)?.state : undefined;
  if (stalled({ status: after.status, state, quietMs, limitMs, questionOpen: pending.hasOpen(t.id) }))
    stop(after, { kind: 'stalled', source: 'stall', text: `No change on the screen or in the transcript for ${Math.max(1, Math.round(quietMs / 60000))} min while the agent waited for the model` });
}
const lastFile = new Map<string, number>();

// --- auto-continue ---
const typing = new Set<string>();
// Called by the watcher for each stopped task with an agentError. Types the message when continueDecision says so.
export async function autoContinue(t: Task): Promise<void> {
  const e = t.agentError;
  if (!e || e.phase !== 'stopped' || t.status !== 'stopped' || typing.has(t.id)) return;
  const now = Date.now();
  // turned on after the stop: plan the next try from the time of the stop
  const p = policy(t, e);
  if (p.enabled && e.auto?.off === 'Auto-continue is off for this task.') {
    store.update(t.id, { agentError: { ...e, auto: { ...e.auto, off: undefined } } });
    return;
  }
  if (p.schedule && (e.auto?.tries || 0) >= p.schedule.maxTries && !e.auto?.off) {
    const off = `Taskboard typed the message ${e.auto?.tries || 0} times and the error came back each time.`;
    store.update(t.id, { agentError: { ...e, auto: { ...e.auto, tries: e.auto?.tries || 0, nextAt: undefined, off } } });
    return;
  }
  if (e.auto?.nextAt && !p.enabled) {
    store.update(t.id, { agentError: { ...e, auto: { ...e.auto, nextAt: undefined, off: 'Auto-continue is off for this task.' } } });
    return;
  }
  if (!e.auto?.nextAt && !e.auto?.off && p.enabled && CONTINUABLE.includes(e.kind)) {
    const due = nextDue(Date.parse(e.seen) || now, e.auto?.tries || 0, 0, p.schedule);
    if (due !== null) { store.update(t.id, { agentError: { ...e, auto: { ...e.auto, tries: e.auto?.tries || 0, maxTries: p.schedule?.maxTries || MAX_TRIES, account: t.account, model: t.model, session: t.session, nextAt: new Date(due).toISOString() } } }); return; }
  }
  if (!e.auto?.nextAt) return;
  const due = e.auto?.nextAt ? Date.parse(e.auto.nextAt) : NaN;
  if (!(due <= now)) return; // nothing to read before it is due
  typing.add(t.id);
  try {
    const current = store.get(t.id);
    if (!current || current.status !== 'stopped' || current.agentError?.auto?.nextAt !== e.auto.nextAt) return;
    const a = accounts.get(current.account) || accounts.defaultFor(current.agent);
    // with colors: the box check tells a typed draft from the gray hint text only by its color (type-command.ts typedText)
    const screen = await tmux.captureStyled(t.session);
    const box = boxState(screen, t.agent as PromptAgent);
    const latest = store.get(t.id);
    if (!latest || latest.status !== 'stopped' || latest.agentError?.auto?.nextAt !== e.auto.nextAt) return;
    const sameTask = isCodexCapacity(t.agent, e)
      ? e.auto?.session === latest.session && e.auto?.account === latest.account && e.auto?.model === latest.model
      : e.auto?.session === undefined || (e.auto.session === latest.session && e.auto.account === latest.account && e.auto.model === latest.model);
    const decision = continueDecision({
      enabled: p.enabled && sameTask, status: latest.status, error: e, accountLimited: !!a?.limited, questionOpen: pending.hasOpen(t.id),
      waitsOnUser: latest.waitingOn?.on === 'user', box, now, maxTries: p.schedule?.maxTries,
    });
    if (decision.act === 'wait') {
      if (e.auto && e.auto.wait !== decision.reason) store.update(t.id, { agentError: { ...e, auto: { ...e.auto, wait: decision.reason } } });
      return;
    }
    if (decision.act === 'off') {
      store.update(t.id, { agentError: { ...e, auto: { ...e.auto, tries: e.auto?.tries || 0, nextAt: undefined, off: decision.reason } } });
      store.appendLog(t.id, { did: `Auto-continue did not type the message: ${decision.reason}`, wait: 'The user: continue the task when the model works again.' });
      return;
    }
    const text = machine.get().agentErrors.message;
    try {
      typed.set(t.id, { at: Date.now(), text });
      await deliverText({ session: t.session, agent: t.agent, num: t.num, id: t.id }, text, undefined, { keepDraft: false });
      if (store.get(t.id)?.status !== 'stopped') { typed.delete(t.id); return; }
      const tries = (e.auto?.tries || 0) + 1;
      const maxTries = p.schedule?.maxTries || MAX_TRIES;
      const next = { ...e, phase: 'resumed' as const, auto: { ...e.auto, tries, maxTries, nextAt: undefined, lastAt: new Date().toISOString() } };
      store.update(t.id, { status: 'working', agentError: next, stopReason: undefined, statusSource: `Auto-continue at ${clock()}: Taskboard typed "${text}" after ${kindLabel(e)} (try ${tries} of ${maxTries}).` });
      store.appendLog(t.id, { did: `Auto-continue: typed "${text}" after ${kindLabel(e)} (${e.text}). Try ${tries} of ${maxTries}. It is an ordinary turn of the agent.`, next: tries < maxTries ? 'Taskboard tries again after the next wait if the error comes back.' : 'No more tries for this error.' });
    } catch (err) {
      // The text may have reached the agent although the check after Enter failed. Typing again could send it twice, so
      // auto-continue ends for this error and the task shows why.
      typed.delete(t.id);
      const reason = err instanceof Error ? err.message : String(err);
      const off = `Typing failed, so Taskboard does not try again for this error: ${reason}`.slice(0, 300);
      store.update(t.id, { agentError: { ...e, auto: { ...e.auto, tries: e.auto?.tries || 0, nextAt: undefined, wait: undefined, off } } });
      store.appendLog(t.id, { did: `Auto-continue: ${off}`, wait: 'The user: look at the input box in the terminal, then continue the task.' });
    }
  } finally { typing.delete(t.id); }
}

// --- the account view ---
// Tasks with an overloaded or server error in the last 15 minutes, for each account. tb accounts and the dashboard
// show it as a note that passes, not as a limit; the controller is told once for each account and episode.
export interface AccountHealth { account: string; name: string; agent: string; kind: 'overloaded'; tasks: number[]; since: string; note: string }
const RECENT_MS = 15 * 60000;
export function health(): AccountHealth[] {
  const by = new Map<string, Task[]>();
  for (const t of store.all()) {
    const e = t.agentError;
    if (!e || t.status === 'archived' || !['overloaded', 'server_error'].includes(e.kind) || e.phase === 'resumed') continue;
    if (Date.now() - Date.parse(e.seen) > RECENT_MS) continue;
    const id = t.account || accounts.defaultFor(t.agent)?.id || t.agent;
    by.set(id, [...(by.get(id) || []), t]);
  }
  return [...by.entries()].filter(([, ts]) => ts.length >= 2).map(([id, ts]) => {
    const a = accounts.get(id);
    const name = a?.agent === 'codex' ? 'Codex' : a?.agent === 'antigravity' ? 'Antigravity' : 'Claude';
    const since = ts.map(t => t.agentError!.since).sort()[0];
    return { account: id, name: a?.name || id, agent: a?.agent || '', kind: 'overloaded', tasks: ts.map(t => t.num).sort((x, y) => x - y), since, note: `${name} model overloaded: ${ts.length} tasks affected (${ts.map(t => `#${t.num}`).join(', ')}). It usually passes; Taskboard does not switch accounts or models.` };
  });
}
const told = new Map<string, number>();
let tellController: (text: string) => void = () => {};
export function onOverload(fn: (text: string) => void) { tellController = fn; }
function noteOverload() {
  for (const h of health()) {
    if (Date.now() - (told.get(h.account) || 0) < 30 * 60000) continue;
    told.set(h.account, Date.now());
    tellController(`[Taskboard] ${h.note} Account ${h.account}. This is a passing health note, not a limit. Do not move tasks only because of it.`);
  }
}
