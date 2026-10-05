// Errors that stop an agent for a while: the model is overloaded or at capacity, a rate limit, a server error, a lost
// connection, an expired sign-in, a conversation that is too long for the model, or a refusal. Credit and usage limits
// are account problems and stay in agent-limits.ts. This file has no tmux or store calls, so tests can run it directly.
//
// Where each agent reports such an error (Claude Code 2.1.289, Codex 0.160.0, study of task 278 on 2026-10-05):
// - Claude Code retries a failed request up to 10 times (500 ms doubled each time, at most 32 s). During the retries the
//   spinner line shows "API error · Retrying in 1s · attempt 1/10"; nothing is written to the transcript. When it gives
//   up, it writes an assistant record with isApiErrorMessage and an `error` kind ("API Error: Connection lost
//   mid-response. …"), runs the StopFailure hook with the same `error`, and goes back to its prompt.
// - Codex retries on its own ("Reconnecting... 2/5" on screen) and then ends the turn. The rollout file gets one
//   task_complete event with error {message, codex_error_info} (task 277: "Selected model is at capacity. Please try a
//   different model.", codex_error_info "server_overloaded"). The screen shows the message after the mark "■". Codex
//   has no hook for it, and its notify program got no event for task 277.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { Agent } from './store.ts';

export type ErrorKind = 'overloaded' | 'rate_limited' | 'server_error' | 'network' | 'auth' | 'context' | 'refused' | 'stalled' | 'other';
// hook: the StopFailure hook of Claude Code · transcript: the Claude Code transcript or the Codex rollout file ·
// screen: the visible terminal screen · stall: no activity for the stall time while the task says it works (inferred)
export type ErrorSource = 'hook' | 'transcript' | 'screen' | 'stall';
export interface ErrorHit {
  kind: ErrorKind; text: string; source: ErrorSource;
  at?: string;        // when the agent reported it (the record time), when known
  attempt?: number;   // the retry the agent shows (Claude Code "attempt 3/10", Codex "Reconnecting... 2/5")
  maxAttempts?: number;
  retryIn?: string;   // "1s", "32s": the wait the agent shows before its next retry
  retrying?: boolean; // the agent still retries by itself
}
// The state that Taskboard keeps on the task (Task.agentError). phase:
// - retrying: the agent shows a retry on its screen and still works; the task stays "working"
// - stopped: the agent stopped on the error (or the stall time passed); the task is "stopped"
// - resumed: Taskboard typed the auto-continue message; the task works again, and the episode stays open until a turn
//   ends without an error, so the tries of one episode are counted together
export interface AgentError extends ErrorHit {
  phase: 'retrying' | 'stopped' | 'resumed';
  since: string;      // when this episode began (the first error after a turn that ended without an error)
  seen: string;       // when Taskboard last read the error
  count: number;      // how many times Taskboard read a stop for this episode
  auto?: AutoState;
}
export interface AutoState {
  tries: number;      // continue messages that Taskboard typed in this episode
  nextAt?: string;    // when the next one is due
  lastAt?: string;
  off?: string;       // why Taskboard does not type one again in this episode (shown on the task)
  wait?: string;      // why the due message waits (a dialog shows); it is tried again on the next check
}

export const KIND_LABEL: Record<ErrorKind, string> = {
  overloaded: 'model overloaded', rate_limited: 'rate limited', server_error: 'server error', network: 'connection lost',
  auth: 'sign-in problem', context: 'conversation too long', refused: 'request refused', stalled: 'no activity', other: 'agent error',
};
// The errors that a plain "continue" can get past. Credit and usage limits are not ErrorKinds (agent-limits.ts);
// a sign-in, a too long conversation and a refusal need a person; a stall is only inferred, and the agent may still run.
export const CONTINUABLE: ErrorKind[] = ['overloaded', 'rate_limited', 'server_error', 'network'];

// the label of one error: Codex says "Selected model is at capacity", so its label says so too
export const kindLabel = (e: Pick<ErrorHit, 'kind' | 'text'>) => e.kind === 'overloaded' && /model is at capacity/i.test(e.text) ? 'model at capacity' : KIND_LABEL[e.kind];
const one = (s: string, n = 200) => s.replace(/\s+/g, ' ').trim().slice(0, n);

// The kind of an error from its text. The order matters: "Repeated 529 Overloaded errors" is overloaded, not a 5xx.
export function kindFromText(text: string): ErrorKind {
  const s = text || '';
  if (/overload|at capacity|high demand|\b529\b|server_overloaded/i.test(s)) return 'overloaded';
  if (/rate.?limit|too many requests|\b429\b/i.test(s)) return 'rate_limited';
  if (/prompt is too long|context (?:window|length|limit)|too long for the (?:model|context)|context_window_exceeded|maximum context/i.test(s)) return 'context';
  if (/usage policy|safety|content (?:policy|filter)|refus/i.test(s)) return 'refused';
  if (/login expired|run \/login|oauth|token (?:has )?expired|invalid api key|authenticat|unauthori[sz]ed|\b401\b|\b403\b/i.test(s)) return 'auth';
  if (/connection (?:lost|error|reset|refused|closed)|stopped arriving|stream disconnected|disconnected before completion|reconnecting|network|timed? ?out|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|no response from the api/i.test(s)) return 'network';
  if (/\b5\d\d\b|server error|internal error|bad gateway|service unavailable|exceeded retry limit|api_error/i.test(s)) return 'server_error';
  return 'other';
}

// Claude Code: the `error` of an isApiErrorMessage record and of the StopFailure hook. 'limit' and 'credit' go to the
// account limit code (agent-limits.ts) instead. A rate_limit with the text of a usage limit is a usage limit.
export function claudeKind(error: string, text = ''): ErrorKind | 'limit' | 'credit' {
  if (error === 'billing_error' || /credit balance/i.test(text)) return 'credit';
  if (/usage limit|hit your (?:usage )?limit|limit reached|weekly limit/i.test(text)) return 'limit';
  switch (error) {
    case 'overloaded': return 'overloaded';
    case 'rate_limit': return 'rate_limited';
    case 'authentication_failed': case 'oauth_org_not_allowed': case 'account_on_hold': case 'verification_required': case 'cloud_credential_error': return 'auth';
  }
  const k = kindFromText(text);
  if (k !== 'other') return k;
  return error === 'server_error' ? 'server_error' : 'other';
}

// Codex: the codex_error_info of a failed task_complete. Unknown values are read from the message.
export function codexKind(info: string, message = ''): ErrorKind | 'limit' | 'credit' {
  if (/credit|billing|payment/i.test(info) || /out of credits|credit balance/i.test(message)) return 'credit';
  if (/usage_limit|quota/i.test(info) || /usage limit/i.test(message)) return 'limit';
  if (/overload/i.test(info)) return 'overloaded';
  if (/too_many_requests|rate_limit/i.test(info)) return 'rate_limited';
  if (/context_window/i.test(info)) return 'context';
  if (/unauthori[sz]ed|auth/i.test(info)) return 'auth';
  const k = kindFromText(message);
  if (k !== 'other') return k;
  if (/connection|stream|timeout/i.test(info)) return 'network';
  if (/server|internal/i.test(info)) return 'server_error';
  return 'other';
}

// --- the screen ------------------------------------------------------------------------------------------------
// Claude Code draws gaps with "cursor forward" escapes (ESC [ n C) instead of spaces. tmux capture-pane without -e
// gives spaces already; the terminal.log has the escapes. plain() makes both read the same.
const plain = (s: string) => s.replace(/\x1b\[(\d*)C/g, (_m, n) => ' '.repeat(Number(n) || 1)).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]/g, '');
const lastLines = (screen: string, n: number) => plain(screen).split('\n').filter(l => l.trim()).slice(-n);

// Claude Code spinner line during a retry: "<label> · Retrying in <time> · attempt <n>/<max>". The label is
// "API error", or from the third attempt the error text. The line starts with the spinner mark; the pattern needs the
// whole shape, so a sentence in a reply that mentions a retry does not match. "Auto mode check unavailable · next try
// in 1s · attempt 1/10" is the auto mode classifier, not the model: it has "next try", so it does not match.
const CLAUDE_RETRY = /^[\s✻✶✳✢✽·*⏺●]*(.{1,160}?)\s+·\s+Retrying in ([0-9][^·]{0,20}?)(?:\s+\([^)]*\))?\s+·\s+attempt (\d+)\/(\d+)\s*$/;
// Codex status line during a retry. "Reconnecting... 2/5" and "stream disconnected - retrying sampling request (2/5 in
// 400ms)..." The mark in front is the working spinner ("•" or "◦") or nothing.
const CODEX_RETRY = [
  /^[\s•◦⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]*(Reconnecting)\.{3}\s*(\d+)\/(\d+)/,
  /^[\s•◦■⚠]*(stream disconnected - retrying (?:sampling )?(?:request|turn))\s*\((\d+)\/(\d+)(?: in ([^)]+))?\)/,
];
// Codex prints a turn error after "■" at the start of a line (task 277). An interrupt ("■ Conversation interrupted")
// uses the same mark, and so do the credit and limit texts that agent-limits.ts reads first.
const CODEX_ERROR = /^\s*■\s+(.+)$/;

// A retry or an error on the screen, or null. Only the bottom lines count: the error that stopped the agent sits just
// above its input box, and older errors further up are history.
export function errorFromScreen(agent: Agent, screen: string): ErrorHit | null {
  const lines = lastLines(screen, 12);
  if (agent === 'claude') {
    for (const l of lines.slice().reverse()) {
      const m = l.match(CLAUDE_RETRY);
      if (!m) continue;
      const label = one(m[1]), kind = kindFromText(label);
      return { kind: kind === 'other' ? 'server_error' : kind, text: label, source: 'screen', retrying: true, retryIn: one(m[2], 20), attempt: Number(m[3]), maxAttempts: Number(m[4]) };
    }
    return null; // a stopped Claude Code is read from the hook and the transcript, which are exact
  }
  if (agent === 'codex') {
    for (const l of lines.slice().reverse()) {
      for (const re of CODEX_RETRY) {
        const m = l.match(re);
        if (m) return { kind: 'network', text: one(m[1]), source: 'screen', retrying: true, attempt: Number(m[2]), maxAttempts: Number(m[3]), retryIn: m[4] ? one(m[4], 20) : undefined };
      }
    }
    // the newest "■" line, only when the prompt is the next thing below it: the agent went back to its prompt after it
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(CODEX_ERROR);
      if (!m) continue;
      const below = lines.slice(i + 1);
      if (!below.some(l => /^\s*›/.test(l)) || below.some(l => /^\s*[•◦]\s/.test(l))) return null;
      const text = one(m[1]);
      if (/^Conversation interrupted/i.test(text)) return null;
      const kind = kindFromText(text);
      return kind === 'other' ? null : { kind, text, source: 'screen' };
    }
  }
  return null;
}

// --- the transcript ---------------------------------------------------------------------------------------------
function tail(path: string, bytes = 262144): string[] {
  const size = statSync(path).size, start = Math.max(0, size - bytes), buf = Buffer.alloc(size - start);
  const fd = openSync(path, 'r'); try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
  const lines = buf.toString('utf8').split('\n');
  if (start > 0) lines.shift();
  return lines.filter(Boolean);
}
const parse = (l: string) => { try { return JSON.parse(l); } catch { return null; } };
export type TranscriptHit = (ErrorHit & { limit?: undefined }) | { limit: 'limit' | 'credit'; text: string; at?: string };

// Claude Code: the newest conversation record, when it is an API error. Records of subagents (isSidechain) are
// skipped: a subagent that failed does not stop the main agent. A prompt or a normal reply after the error means the
// agent went on, so there is no error.
export function claudeTranscriptError(lines: string[]): TranscriptHit | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const o = parse(lines[i]);
    if (!o || o.isSidechain || (o.type !== 'user' && o.type !== 'assistant')) continue;
    if (o.type === 'user' && (o.isMeta || (typeof o.message?.content === 'string' && /^\s*<(task-notification|local-command|command-name|system-reminder)/.test(o.message.content)))) continue;
    if (o.type !== 'assistant' || !o.isApiErrorMessage) return null;
    const c = o.message?.content;
    const text = one(Array.isArray(c) ? c.filter((p: any) => p.type === 'text').map((p: any) => p.text).join(' ') : String(c ?? ''));
    const kind = claudeKind(String(o.error || ''), text);
    if (kind === 'limit' || kind === 'credit') return { limit: kind, text, at: o.timestamp };
    return { kind, text: text || 'API Error', source: 'transcript', at: o.timestamp };
  }
  return null;
}

// Codex: the newest turn result, when the turn failed. A turn that started after it (task_started, user_message)
// means that the agent went on.
export function codexRolloutError(lines: string[]): TranscriptHit | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const o = parse(lines[i]); const p = o?.payload;
    if (!p || o.type !== 'event_msg') continue;
    if (p.type === 'task_started' || p.type === 'user_message' || p.type === 'turn_aborted') return null;
    if (p.type === 'error' && p.message) {
      // older Codex versions wrote the error as its own event before the end of the turn
      const kind = codexKind(String(p.codex_error_info || ''), String(p.message));
      return kind === 'limit' || kind === 'credit' ? { limit: kind, text: one(String(p.message)), at: o.timestamp } : { kind, text: one(String(p.message)), source: 'transcript', at: o.timestamp };
    }
    if (p.type !== 'task_complete') continue;
    if (!p.error) return null;
    const message = one(String(p.error.message || '')), kind = codexKind(String(p.error.codex_error_info || ''), message);
    if (kind === 'limit' || kind === 'credit') return { limit: kind, text: message, at: o.timestamp };
    return { kind, text: message || String(p.error.codex_error_info || 'Codex error'), source: 'transcript', at: o.timestamp };
  }
  return null;
}

export function transcriptError(agent: Agent, path: string): TranscriptHit | null {
  try {
    const lines = tail(path);
    return agent === 'claude' ? claudeTranscriptError(lines) : agent === 'codex' ? codexRolloutError(lines) : null;
  } catch { return null; }
}

// --- the stall rule ---------------------------------------------------------------------------------------------
// The screen without the parts that change while an agent waits: the elapsed time and the word of the spinner. The
// count of received tokens stays, so a model that still streams its answer changes this text. Claude Code: "✻
// Pondering… (2m 3s · ↓ 1.2k tokens · esc to interrupt)". Codex: "• Working (1m 23s • esc to interrupt)".
export function screenSignature(screen: string): string {
  return lastLines(screen, 40).map(l => {
    if (!/esc to interrupt|esc to cancel/i.test(l) && !/^\s*[✻✶✳✢✽·*]\s+\S+…/.test(l)) return l.replace(/\s+$/, '');
    const tokens = l.match(/[↓↑]\s*([\d.,]+k?)\s*tokens/);
    return tokens ? `[tokens ${tokens[1]}]` : '[spinner]';
  }).join('\n');
}

export const DEFAULT_STALL_MINUTES = 5;
export interface StallInput {
  status: string;              // the task status
  state?: 'finished' | 'tool' | 'busy' | 'aborted' | 'unknown'; // external.readState of the transcript
  quietMs: number;             // time since the later of: the last change of screenSignature, the transcript mtime
  limitMs: number;             // the stall time (Settings)
  questionOpen: boolean;       // a question card or a screen question is open
}
// A task stalls only when it says it works, waits for the model (the transcript ends with a prompt or a tool result),
// and neither its screen nor its transcript changed for the stall time. A tool call without a result is a running
// tool (a build, a test, a sleep) or a question for you, so it never stalls, however long it runs.
export function stalled(i: StallInput): boolean {
  if (i.status !== 'working' || i.questionOpen) return false;
  if (i.state !== 'busy') return false;
  return i.quietMs >= i.limitMs;
}

// --- auto-continue ----------------------------------------------------------------------------------------------
export const BACKOFF_MINUTES = [1, 2, 5, 10, 10];
export const MAX_TRIES = BACKOFF_MINUTES.length;
export const DEFAULT_MESSAGE = 'continue';
// When the next message is due after `tries` messages, from the time of the stop. A rate limit with a shown wait
// waits at least that long.
export function nextDue(stoppedAt: number, tries: number, retryAfterMs = 0): number | null {
  if (tries >= MAX_TRIES) return null;
  return stoppedAt + Math.max(BACKOFF_MINUTES[tries] * 60000, retryAfterMs);
}
export interface ContinueCheck {
  enabled: boolean; status: string; error?: AgentError; accountLimited: boolean; questionOpen: boolean;
  waitsOnUser: boolean; box: 'empty' | 'draft' | 'question' | 'no-box'; now: number;
}
// What auto-continue does now: 'type' the message, 'wait' (not due, or a dialog shows), or 'off' with the reason that
// ends auto-continue for this episode. The reasons are shown on the task, so they are full sentences.
export function continueDecision(c: ContinueCheck): { act: 'type' | 'wait' | 'off'; reason: string } {
  const e = c.error;
  if (!c.enabled) return { act: 'off', reason: 'Auto-continue is off for this task.' };
  if (!e || e.phase !== 'stopped' || c.status !== 'stopped') return { act: 'wait', reason: 'The agent has not stopped on an error.' };
  if (!CONTINUABLE.includes(e.kind)) return { act: 'off', reason: `Auto-continue does not retry ${e.kind === 'stalled' ? 'a stall, because the agent may still run' : `a ${KIND_LABEL[e.kind]} error`}.` };
  if (c.accountLimited) return { act: 'off', reason: 'The account has a limit mark. Auto-continue never retries a usage limit or a credit problem.' };
  if (e.auto?.off) return { act: 'off', reason: e.auto.off };
  if ((e.auto?.tries || 0) >= MAX_TRIES) return { act: 'off', reason: `Taskboard typed the message ${MAX_TRIES} times and the error came back each time.` };
  if (c.questionOpen || c.waitsOnUser) return { act: 'off', reason: 'The task waits on a card or a question.' };
  const due = e.auto?.nextAt ? Date.parse(e.auto.nextAt) : NaN;
  if (!(due <= c.now)) return { act: 'wait', reason: 'Not due yet.' };
  if (c.box === 'draft') return { act: 'off', reason: 'A person typed in the input box. Taskboard does not type over a draft.' };
  if (c.box !== 'empty') return { act: 'wait', reason: c.box === 'question' ? 'A dialog or question shows on the screen.' : 'The input box does not show.' };
  return { act: 'type', reason: '' };
}

// The one-line state for lists (tb list, the task row): "Stopped: model overloaded", "Retrying (attempt 3/10)".
export function shortLabel(e: AgentError | undefined): string {
  if (!e) return '';
  if (e.phase === 'retrying') return `Retrying${e.attempt ? ` (attempt ${e.attempt}${e.maxAttempts ? `/${e.maxAttempts}` : ''})` : ''}`;
  if (e.phase === 'resumed') return `Continued after ${KIND_LABEL[e.kind]}${e.auto?.tries ? ` (try ${e.auto.tries}/${MAX_TRIES})` : ''}`;
  return e.kind === 'stalled' ? 'Stalled: no activity (inferred)' : `Stopped: ${kindLabel(e)}`;
}

// --- the state machine ------------------------------------------------------------------------------------------
// The new state of a task after Taskboard read `hit`. prev is the state before (undefined after a turn that ended
// without an error). An episode starts with the first error and ends only when a turn ends without an error, so the
// auto-continue tries of one episode add up: an error that comes back after "continue" is the same episode.
// autoOn: auto-continue applies to this task. The next try is planned only for a stop of a kind in CONTINUABLE.
export function applyHit(prev: AgentError | undefined, hit: ErrorHit, now: number, autoOn: boolean): AgentError {
  const iso = new Date(now).toISOString();
  const since = prev?.since || iso;
  if (hit.retrying) return { ...hit, phase: 'retrying', since, seen: iso, count: prev?.count || 0, auto: prev?.auto };
  const newStop = prev?.phase !== 'stopped';
  const tries = prev?.auto?.tries || 0;
  let auto: AutoState | undefined = prev?.auto ? { ...prev.auto, wait: undefined } : undefined;
  if (autoOn && CONTINUABLE.includes(hit.kind) && newStop && !auto?.off) {
    const due = nextDue(now, tries);
    auto = due === null ? { ...auto, tries, nextAt: undefined, off: `Taskboard typed the message ${MAX_TRIES} times and the error came back each time.` } : { ...auto, tries, nextAt: new Date(due).toISOString() };
  }
  return { ...hit, phase: 'stopped', since, seen: iso, count: (prev?.count || 0) + (newStop ? 1 : 0), ...(auto ? { auto } : {}) };
}
