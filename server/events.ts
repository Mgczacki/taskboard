// Turning hook events into task status. Status must be trustworthy, so each rule is tied to a specific event.
import { statSync } from 'node:fs';
import * as docs from './docs.ts';
import * as accounts from './accounts.ts';
import * as store from './store.ts';
import * as external from './external.ts';
import type { Task } from './store.ts';

const turnStart = new Map<string, number>();   // task id -> when the current turn began
const blockedOnce = new Set<string>();          // Stop hook already asked for a log entry this turn
const answerBeforeLog = new Map<string, string>(); // the agent's real answer, saved when we asked it for a log entry
export const viewing = new Set<string>();       // task ids open in some UI window right now

const firstPara = (s = '') => s.trim().split(/\n\s*\n/)[0].replace(/\s+/g, ' ').slice(0, 280);
const lastSentence = (s = '') => { const x = s.trim().replace(/\s+/g, ' '); const m = x.match(/[^.!?]*\?\s*$/); return (m ? m[0] : x.slice(-200)).trim(); };
const endsWithQuestion = (s = '') => /\?\s*$/.test(s.trim());
const clock = () => new Date().toTimeString().slice(0, 5);

function finishedStatus(t: Task, msg: string) {
  // a document waiting for your review keeps the task in 'review' until you act on it
  if (t.status === 'review') return { status: 'review' as const, ask: t.ask || '' };
  if (endsWithQuestion(msg)) return { status: 'needs-you' as const, ask: lastSentence(msg) };
  return { status: viewing.has(t.id) ? 'idle' as const : 'unread' as const, ask: '' };
}

function describeTool(name: string, input: any): string {
  if (!input) return name;
  if (name === 'Bash') return `Run: ${input.command}`;
  if (input.file_path) return `${name} ${input.file_path}`;
  if (input.url) return `${name} ${input.url}`;
  return name;
}

export function claudeEvent(taskId: string, input: any): { output?: unknown } {
  const t = store.get(taskId); if (!t) return {};
  // an archived task stays archived whatever its agent still reports
  if (t.status === 'archived') return {};
  const ev = input.hook_event_name;
  switch (ev) {
    case 'SessionStart':
      sessionStarted.add(t.id);
      store.update(t.id, { sessionId: input.session_id || t.sessionId, transcript: input.transcript_path, ...(t.status === 'suspended' ? { status: 'idle' as const } : {}) });
      break;
    case 'UserPromptSubmit':
      answerBeforeLog.delete(t.id); // a saved answer belongs to the previous turn only
      turnStart.set(t.id, Date.now()); blockedOnce.delete(t.id);
      store.update(t.id, { status: 'working', ask: '', stopReason: undefined, interrupted: undefined, statusSource: `Claude Code UserPromptSubmit hook at ${clock()}.` });
      { const notice = docs.takeInboxNotice(t.id); if (notice) return { output: { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: notice } } }; }
      break;
    case 'PermissionRequest':
      store.update(t.id, { status: 'needs-you', ask: describeTool(input.tool_name, input.tool_input), statusSource: `Claude Code PermissionRequest hook at ${clock()}: ${input.tool_name}.` });
      break;
    case 'Notification': {
      const type = input.notification_type || '';
      if (['permission_prompt', 'agent_needs_input', 'elicitation_dialog'].includes(type) && t.status !== 'needs-you')
        store.update(t.id, { status: 'needs-you', ask: input.message || 'Claude is waiting for you', statusSource: `Claude Code Notification (${type}) at ${clock()}.` });
      break;
    }
    case 'PostToolUse':
      if (t.status === 'needs-you') store.update(t.id, { status: 'working', ask: '', statusSource: `Approved; tool ran at ${clock()}.` });
      break;
    case 'Stop': {
      // Ask for a log entry once per turn if the agent did not write one. stop_hook_active prevents loops.
      const started = turnStart.get(t.id) || 0;
      let logged = true;
      try { logged = statSync(store.logFile(t.id)).mtimeMs >= started; } catch { logged = false; }
      if (!logged && started && t.role !== 'controller' && !input.stop_hook_active && !blockedOnce.has(t.id)) {
        blockedOnce.add(t.id);
        answerBeforeLog.set(t.id, input.last_assistant_message || '');
        return { output: { decision: 'block', reason: `Append your Did / Waiting / Next entry to ${store.logFile(t.id)} as described in your instructions, then stop. Do not mention the log in your reply.` } };
      }
      // after a log request, the agent's last message is about the log; show its real answer instead
      accounts.clearLimited(t.account);
      const msg = answerBeforeLog.get(t.id) || input.last_assistant_message || '';
      answerBeforeLog.delete(t.id);
      store.update(t.id, { ...finishedStatus(t, msg), now: firstPara(msg) || t.now, statusSource: `Claude Code Stop hook at ${clock()}.` });
      break;
    }
    case 'StopFailure':
      answerBeforeLog.delete(t.id);
      if (/rate|limit|quota|billing/i.test(String(input.error_type || input.error || ''))) accounts.markLimited(t.account || accounts.defaultFor(t.agent).id, `${input.error_type || 'limit'} on #${t.num}`);
      store.update(t.id, { status: 'stopped', stopReason: input.error_type || input.error || 'API error', statusSource: `Claude Code StopFailure at ${clock()}: ${input.error_type || 'error'}.` });
      break;
  }
  return {};
}

export function codexEvent(taskId: string, p: any) {
  const t = store.get(taskId); if (!t || t.status === 'archived') return;
  if (p.type !== 'agent-turn-complete') return;
  accounts.clearLimited(t.account);
  const msg: string = p['last-assistant-message'] || '';
  // Codex also runs a short internal turn to name the conversation; its reply is JSON like {"title": "..."}.
  if (/^\s*\{\s*"title"\s*:/.test(msg)) return;
  store.update(t.id, { sessionId: p['thread-id'] || t.sessionId, ...finishedStatus(t, msg), now: firstPara(msg) || t.now, statusSource: `Codex notify (agent-turn-complete) at ${clock()}.` });
  if (msg) store.appendLog(t.id, { did: firstPara(msg).slice(0, 200), wait: endsWithQuestion(msg) ? lastSentence(msg) : 'Nothing.' });
  lastCodexEvent.set(t.id, Date.now());
}

export const lastCodexEvent = new Map<string, number>();

// Antigravity (agy) hooks, from the Taskboard plugin (server/hooks/agy-hook.mjs). agy has no prompt-submitted,
// notification or permission event. A turn starts with PreInvocation (invocationNum 0: the first model call after a
// prompt) and ends with Stop (fullyIdle true). An approval question has no event; the watcher reads it from the screen
// while the task is working (agyApprovalCheck), and PostToolUse ends it. A Stop hook that answers {decision: "continue", reason}
// makes agy run again with the reason as input (observed with agy 1.2.12); an empty answer lets it stop.
export const agyPendingTool = new Map<string, string>(); // task id -> the tool call that has no PostToolUse yet
function describeAgyTool(tc: any): string {
  const a = tc?.args || {};
  const oneLine = (x: string) => { const l = String(x).trim().split('\n'); return l[0].slice(0, 160) + (l.length > 1 || l[0].length > 160 ? ' …' : ''); };
  if (a.CommandLine) return `Run: ${oneLine(a.CommandLine)}`;
  const file = a.TargetFile || a.AbsolutePath || a.FilePath || a.Path;
  return file ? `${tc?.name} ${file}` : String(tc?.name || 'a tool');
}
export function antigravityEvent(taskId: string, ev: string, input: any): { output?: unknown } {
  const t = store.get(taskId); if (!t || t.status === 'archived') return {};
  sessionStarted.add(t.id);
  // every event carries the conversation id and transcript path; the first one is how Taskboard learns the id
  const ids: Partial<Task> = {};
  if (input.conversationId && input.conversationId !== t.sessionId) ids.sessionId = input.conversationId;
  if (input.transcriptPath && input.transcriptPath !== t.transcript) ids.transcript = input.transcriptPath;
  if (Object.keys(ids).length) store.update(t.id, ids);
  switch (ev) {
    case 'PreInvocation':
      // a new turn (a Stop "continue" keeps the task working, so it is not one)
      if (input.invocationNum === 0 && t.status !== 'working') {
        answerBeforeLog.delete(t.id); turnStart.set(t.id, Date.now()); blockedOnce.delete(t.id); agyPendingTool.delete(t.id);
        store.update(t.id, { status: 'working', ask: '', stopReason: undefined, interrupted: undefined, statusSource: `Antigravity PreInvocation hook at ${clock()}.` });
      }
      break;
    case 'PreToolUse':
      agyPendingTool.set(t.id, describeAgyTool(input.toolCall));
      break;
    case 'PostToolUse':
      agyPendingTool.delete(t.id);
      if (t.status === 'needs-you') store.update(t.id, { status: 'working', ask: '', statusSource: `Approved; tool ran at ${clock()}.` });
      break;
    case 'Stop': {
      if (input.fullyIdle === false) break; // agy still has work queued
      agyPendingTool.delete(t.id);
      const err = String(input.error || '');
      if (err) {
        answerBeforeLog.delete(t.id);
        if (/rate|limit|quota|exhaust|billing|credits/i.test(err)) accounts.markLimited(t.account || accounts.defaultFor(t.agent).id, `${err.slice(0, 80)} on #${t.num}`);
        store.update(t.id, { status: 'stopped', stopReason: err.slice(0, 200), statusSource: `Antigravity Stop hook at ${clock()}: ${input.terminationReason || 'error'}.` });
        break;
      }
      const reply = t.transcript ? external.readState('antigravity', t.transcript)?.text : undefined;
      // ask for a log entry once per turn if the agent did not write one (as for Claude Code)
      const started = turnStart.get(t.id) || 0;
      let logged = true;
      try { logged = statSync(store.logFile(t.id)).mtimeMs >= started; } catch { logged = false; }
      if (!logged && started && t.role !== 'controller' && !blockedOnce.has(t.id)) {
        blockedOnce.add(t.id);
        answerBeforeLog.set(t.id, reply || '');
        return { output: { decision: 'continue', reason: `Append your Did / Waiting / Next entry to ${store.logFile(t.id)} as described in your instructions, then stop. Do not mention the log in your reply.` } };
      }
      // agy has no event that adds context to a prompt: files that arrived in the inbox are passed on here instead
      const notice = t.role === 'controller' ? null : docs.takeInboxNotice(t.id);
      // the reply after reading the files is the newer answer, so no earlier one is kept for it
      if (notice) { answerBeforeLog.delete(t.id); return { output: { decision: 'continue', reason: notice } }; }
      accounts.clearLimited(t.account);
      const msg = answerBeforeLog.get(t.id) || reply || '';
      answerBeforeLog.delete(t.id);
      store.update(t.id, { ...finishedStatus(t, msg), now: firstPara(msg) || t.now, statusSource: `Antigravity Stop hook at ${clock()}.` });
      break;
    }
  }
  return {};
}
// agy's approval questions differ by tool ("Run this command?", "Allow creation of this file?"), but each one ends
// with a numbered list of answers from "1. Yes, …" to "No, cancel" or "No, deny …" (observed with agy 1.2.12).
const AGY_APPROVAL = /^\s*(>\s*)?1\. Yes\b[\s\S]*\bNo, (cancel|deny)\b/m;
export function agyApprovalCheck(t: Task, screen: string) {
  if (t.status !== 'working' || !AGY_APPROVAL.test(screen)) return;
  // the question line (for example "Allow creation of this file?") when no tool call was reported
  const question = screen.split('\n').map(l => l.trim()).filter(l => /\?$/.test(l)).pop();
  const tool = agyPendingTool.get(t.id);
  store.update(t.id, { status: 'needs-you', ask: tool ? `Approve: ${tool}` : question || 'Antigravity asks for approval', statusSource: `${SCREEN_SOURCE} at ${clock()} (agy has no approval event).` });
}

// Some questions appear before any hook can fire, for example "Do you trust this folder?" the first time
// an agent runs in a new folder. For a minute after launch the watcher reads the screen and flags these.
const SCREEN_QUESTIONS: [RegExp, string][] = [
  [/trust this folder|Do you trust the (files|contents)/i, 'Asks whether to trust this folder (first run here). Answer in the terminal.'],
  [/Select login method|Please log in|Sign in with ChatGPT/i, 'Asks you to sign in. Answer in the terminal.'],
  [/Update available[\s\S]*(Update now|Skip)/i, 'Offers an update before starting. Answer in the terminal (Skip continues).'],
  // while it is on screen, an Antigravity approval (set by agyApprovalCheck) stays in "needs you"
  [AGY_APPROVAL, 'Asks to approve a tool call. Answer in the terminal.'],
];
export const SCREEN_SOURCE = 'Read from the terminal';
export function screenCheck(t: Task, screen: string) {
  if (t.status === 'needs-you') {
    // a question read from the screen: once it is no longer there, it was answered and the agent carries on
    if (t.statusSource?.startsWith(SCREEN_SOURCE) && !SCREEN_QUESTIONS.some(([re]) => re.test(screen)))
      store.update(t.id, { status: 'working', ask: '', statusSource: `The question on screen was answered (seen at ${clock()}).` });
    return;
  }
  for (const [re, ask] of SCREEN_QUESTIONS) if (re.test(screen)) {
    store.update(t.id, { status: 'needs-you', ask, statusSource: `${SCREEN_SOURCE} at ${clock()} (no hook fires for this question).` });
    return;
  }
}
export const sessionStarted = new Set<string>();

// Codex rings the terminal bell when it waits for approval; tmux reports the bell for the session.
export function bell(session: string) {
  const t = store.all().find(x => x.session === session); if (!t || t.agent !== 'codex') return;
  store.update(t.id, { status: 'needs-you', ask: 'Codex is waiting for your approval', statusSource: `Terminal bell (approval requested) at ${clock()}.` });
  lastCodexEvent.set(t.id, Date.now());
}

// Codex has no "prompt submitted" event here. Its transcript file only changes when the conversation does
// (a prompt, a tool call, a reply), never for screen redraws, so a change after a finished turn means it is working again.
export function codexActivity(t: Task, transcriptMtime: number) {
  if (Date.now() - (store.launchedAt.get(t.id) || 0) < 20000) return; // starting or resuming, not working
  const last = Math.max(lastCodexEvent.get(t.id) || 0, Date.parse(t.statusAt) || 0, (store.launchedAt.get(t.id) || 0) + 20000);
  if (transcriptMtime > last + 1500 && ['unread', 'idle', 'needs-you'].includes(t.status)) {
    store.update(t.id, { status: 'working', ask: '', statusSource: `Codex transcript changed at ${clock()}.` });
    lastCodexEvent.set(t.id, transcriptMtime);
  }
}
