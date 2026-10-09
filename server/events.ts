// Turning hook events into task status. Status must be trustworthy, so each rule is tied to a specific event.
import { statSync } from 'node:fs';
import { lastRefusal } from './claude-refusal.ts';
import { lastCodexRefusal, type CommandRefusal } from './command-refusal.ts';
import * as permits from './permits.ts';
import * as pending from './pending.ts';
import * as approvals from './approvals.ts';
import * as agents from './agents.ts';
import * as docs from './docs.ts';
import * as review from './review.ts';
import * as accounts from './accounts.ts';
import * as machine from './machine.ts';
import * as external from './external.ts';
import * as store from './store.ts';
import type { Task } from './store.ts';
import * as messageQueue from './message-queue.ts';
import { transcriptFor } from './importer.ts';
import * as agentErrors from './agent-error-watch.ts';
import { transcriptError } from './agent-errors.ts';
import { CODEX_QUESTIONS, CODEX_QUESTION_OPEN, CODEX_ASYNC_OPEN } from './screen-prompts.ts';

const turnStart = new Map<string, number>();   // task id -> when the current turn began
const blockedOnce = new Set<string>();          // Stop hook already asked for a log entry this turn
const answerBeforeLog = new Map<string, string>(); // the agent's real answer, saved when we asked it for a log entry
export const viewing = new Set<string>();       // task ids open in some UI window right now

// Ignore the old process while an account move stops it.
export const movingTasks = new Set<string>();
export function resetSessionEvents(id: string) {
  turnStart.delete(id); blockedOnce.delete(id); answerBeforeLog.delete(id);
  lastCodexEvent.delete(id); agyPendingTool.delete(id); sessionStarted.delete(id);
}
export function forgetTask(id: string) {
  resetSessionEvents(id);
  viewing.delete(id);
  movingTasks.delete(id);
}
function acceptsEvent(t: Task, agent: store.Agent, session?: string) {
  return t.agent === agent && !movingTasks.has(t.id) && !(session && session !== t.sessionId && t.pastSessions?.includes(session));
}

const firstPara = (s = '') => s.trim().split(/\n\s*\n/)[0].replace(/\s+/g, ' ').slice(0, 280);
const logDid = (s: string) => {
  const line = s.trim().split(/\n\s*\n/)[0].replace(/\s+/g, ' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  if (line.length <= 200) return line;
  const cut = line.slice(0, 197);
  const space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : cut).trimEnd() + '…';
};
const lastSentence = (s = '') => { const x = s.trim().replace(/\s+/g, ' '); const m = x.match(/[^.!?]*\?\s*$/); return (m ? m[0] : x.slice(-200)).trim(); };
const endsWithQuestion = (s = '') => /\?\s*$/.test(s.trim());
const clock = () => new Date().toTimeString().slice(0, 5);

function finishedStatus(t: Task, msg: string) {
  // a document waiting for your review puts the task back in 'review' at the end of every turn until you act on it.
  // The review list decides, not the status: a new turn changes the status to 'working' in the meantime.
  const pending = review.pendingFor(t.id);
  if (pending) return { status: 'review' as const, ask: `Review ${pending.name}` };
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

// The user cleared the conversation (/clear in Claude Code, /new in Codex). The agent now waits for a prompt in a new
// session, so the status, question and last message of the old conversation no longer apply. Goal and description stay.
function clearedPatch(t: Task, newId: string | undefined, how: string): Partial<Task> {
  turnStart.delete(t.id); blockedOnce.delete(t.id); answerBeforeLog.delete(t.id);
  store.appendLog(t.id, { did: `The user cleared the conversation (${how}). New session ${newId || 'unknown'}.`, next: 'Wait for the next prompt.' });
  return {
    pastSessions: t.sessionId && t.sessionId !== newId ? [...(t.pastSessions || []), t.sessionId] : t.pastSessions,
    // a document waiting for review, or a parked task, keeps its status
    ...(['review', 'parked'].includes(t.status) ? {} : { status: 'idle' as const, ask: '' }),
    now: undefined, stopReason: undefined, interrupted: undefined, agentError: undefined,
    statusSource: `Conversation cleared (${how}) at ${clock()}.`,
  };
}

export function claudeEvent(taskId: string, input: any): { output?: unknown } {
  const t = store.get(taskId); if (!t) return {};
  // an archived task stays archived whatever its agent still reports
  if (t.status === 'archived' || !acceptsEvent(t, 'claude', input.session_id)) return {};
  const ev = input.hook_event_name;
  // a permission hook that still waits for a card answer is released when the agent moved on (pending.releaseClaude)
  if (ev === 'PostToolUse') pending.releaseClaude(t.id, input);
  else if (['UserPromptSubmit', 'Stop', 'StopFailure', 'SessionStart'].includes(ev)) pending.releaseClaude(t.id);
  switch (ev) {
    case 'SessionStart':
      sessionStarted.add(t.id);
      // source is startup, resume, clear or compact; only clear starts a new conversation in the same process
      store.update(t.id, { sessionId: input.session_id || t.sessionId, transcript: input.transcript_path, ...(t.status === 'suspended' ? { status: 'idle' as const } : {}),
        ...(input.source === 'clear' ? clearedPatch(t, input.session_id, '/clear') : {}) });
      break;
    case 'UserPromptSubmit':
      answerBeforeLog.delete(t.id); // a saved answer belongs to the previous turn only
      turnStart.set(t.id, Date.now()); blockedOnce.delete(t.id);
      store.update(t.id, { status: 'working', ask: '', stopReason: undefined, interrupted: undefined, ...agentErrors.promptSubmitted(t, input.prompt), statusSource: `Claude Code UserPromptSubmit hook at ${clock()}.` });
      {
        const notice = docs.takeInboxNotice(t.id);
        const usage = t.role === 'controller' ? controllerUsage() : '';
        // messages that waited in the queue (message-queue.ts); they are marked delivered when they are in this text
        const messages = messageQueue.takeForHook(t.id, 'UserPromptSubmit', messageQueue.HOOK_ROOM - (notice?.length || 0) - usage.length);
        const context = [notice, messages, usage].filter(Boolean).join('\n\n');
        if (context) return { output: { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } } };
      }
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
    case 'PostToolUse': {
      if (t.status === 'needs-you') store.update(t.id, { status: 'working', ask: '', statusSource: `Approved; tool ran at ${clock()}.` });
      // New inbox files reach a working agent at its next tool call, not only at its next prompt. Claude Code 2.1.287
      // gives the model the additionalContext of a PostToolUse hook with the tool result (observed in a test session).
      // Queued messages (message-queue.ts) reach a busy agent the same way, with the text of each message.
      const notice = docs.takeInboxNotice(t.id);
      const messages = messageQueue.takeForHook(t.id, 'PostToolUse', messageQueue.HOOK_ROOM - (notice?.length || 0));
      const context = [notice, messages].filter(Boolean).join('\n\n');
      if (context) return { output: { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } } };
      break;
    }
    case 'Stop': {
      // Ask for a log entry once per turn if the agent did not write one. stop_hook_active prevents loops.
      const started = turnStart.get(t.id) || 0;
      let logged = true;
      try { logged = statSync(store.logFile(t.id)).mtimeMs >= started; } catch { logged = false; }
      const askLog = !logged && started && t.role !== 'controller' && !input.stop_hook_active && !blockedOnce.has(t.id);
      // Queued messages (message-queue.ts) keep the turn going: "block" gives the reason to the model, and Claude Code
      // continues. Each message is given once, so this ends when the queue is empty.
      const messages = messageQueue.takeForHook(t.id, 'Stop');
      if (askLog || messages) {
        if (askLog) { blockedOnce.add(t.id); answerBeforeLog.set(t.id, input.last_assistant_message || ''); }
        const log = askLog ? `Append your Did / Waiting / Next entry to ${store.logFile(t.id)} as described in your instructions, then stop. Do not mention the log in your reply.` : '';
        return { output: { decision: 'block', reason: [messages ? `${messages}\n\nRead the messages and act on them as needed.` : '', log].filter(Boolean).join('\n\n') } };
      }
      // after a log request, the agent's last message is about the log; show its real answer instead
      accounts.clearLimited(t.account);
      const msg = answerBeforeLog.get(t.id) || input.last_assistant_message || '';
      answerBeforeLog.delete(t.id);
      const refusal = t.role !== 'controller' && input.transcript_path ? lastRefusal(input.transcript_path, started) : null;
      if (refusal) {
        recordCommandRefusal(t, refusal, 'Claude Code auto mode');
        store.update(t.id, { now: firstPara(msg) || t.now, ...agentErrors.turnEnded(store.get(t.id)!) });
        break;
      }
      store.update(t.id, { ...finishedStatus(t, msg), now: firstPara(msg) || t.now, ...agentErrors.turnEnded(t), statusSource: `Claude Code Stop hook at ${clock()}.` });
      break;
    }
    case 'StopFailure': {
      // Claude Code 2.1.289 sends `error` (overloaded, rate_limit, server_error, authentication_failed, billing_error,
      // ...) and last_assistant_message ("API Error: ..."); there is no error_type field. A model error goes to
      // agent-error-watch.ts; a credit or usage limit marks the account, as before.
      answerBeforeLog.delete(t.id);
      if (t.role !== 'controller' && agentErrors.stopFailure(t, input)) break;
      const error = String(input.error || 'API error'), text = String(input.last_assistant_message || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      accounts.markLimited(t.account || accounts.defaultFor(t.agent).id, `${text || error} (on #${t.num})`);
      store.update(t.id, { status: 'stopped', stopReason: text || error, statusSource: `Claude Code StopFailure at ${clock()}: ${error}.` });
      break;
    }
  }
  return {};
}

// The account usage and routing rules that the controller gets with each prompt (Claude Code and Codex
// UserPromptSubmit hooks). Antigravity has no hook that adds text to a prompt; its controller runs `tb accounts`.
function controllerUsage() {
  return `${accounts.usageSummary(id => store.all().filter(x => (x.account || accounts.defaultFor(x.agent).id) === id && ['working', 'needs-you', 'unread', 'idle', 'review', 'stopped'].includes(x.status)).length)}\nMachine routing rules: ${machine.get().routingRules || '(none)'}\n${accounts.all().filter(a => a.routingRules).map(a => `${a.id} rule: ${a.routingRules}`).join('\n')}`;
}

// Codex hooks of the controller (server/hooks/codex-hook.mjs; agents.ts CODEX_CONTROLLER_HOOKS). Codex sends the same
// fields as Claude Code (hook_event_name, session_id, transcript_path, last_assistant_message). The end of a turn and
// the log entry still come from the notify program (codexEvent). These hooks give text to the model:
// - UserPromptSubmit: new inbox files, queued messages and the account usage, as additionalContext
// - PostToolUse: new inbox files and queued messages, as additionalContext
// - Stop: queued messages, with {decision: "block", reason}; Codex then runs one more turn with the reason
export function codexHookEvent(taskId: string, input: any): { output?: unknown } {
  const t = store.get(taskId); if (!t || t.status === 'archived' || !acceptsEvent(t, 'codex', input.session_id)) return {};
  const ids: Partial<Task> = {};
  if (input.session_id && input.session_id !== t.sessionId) ids.sessionId = input.session_id;
  if (input.transcript_path && input.transcript_path !== t.transcript) ids.transcript = input.transcript_path;
  switch (input.hook_event_name) {
    case 'UserPromptSubmit': {
      store.update(t.id, { ...ids, status: 'working', ask: '', stopReason: undefined, interrupted: undefined, statusSource: `Codex UserPromptSubmit hook at ${clock()}.` });
      const notice = docs.takeInboxNotice(t.id);
      const usage = t.role === 'controller' ? controllerUsage() : '';
      const messages = messageQueue.takeForHook(t.id, 'UserPromptSubmit', messageQueue.HOOK_ROOM - (notice?.length || 0) - usage.length);
      const context = [notice, messages, usage].filter(Boolean).join('\n\n');
      if (context) return { output: { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } } };
      break;
    }
    case 'PostToolUse': {
      if (Object.keys(ids).length) store.update(t.id, ids);
      const notice = docs.takeInboxNotice(t.id);
      const messages = messageQueue.takeForHook(t.id, 'PostToolUse', messageQueue.HOOK_ROOM - (notice?.length || 0));
      const context = [notice, messages].filter(Boolean).join('\n\n');
      if (context) return { output: { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } } };
      break;
    }
    case 'Stop': {
      if (Object.keys(ids).length) store.update(t.id, ids);
      const messages = messageQueue.takeForHook(t.id, 'Stop');
      if (messages) return { output: { decision: 'block', reason: `${messages}\n\nRead the messages and act on them as needed.` } };
      break;
    }
  }
  return {};
}

export function codexEvent(taskId: string, p: any) {
  const t = store.get(taskId); if (!t || t.status === 'archived' || !acceptsEvent(t, 'codex', p['thread-id'])) return;
  if (p.type !== 'agent-turn-complete') return;
  // a turn that failed on a model error: the rollout file has the error (agent-error-watch.ts shows it)
  const failed = t.role !== 'controller' && t.transcript ? transcriptError('codex', t.transcript) : null;
  if (failed && !failed.limit) { agentErrors.stop(t, failed); lastCodexEvent.set(t.id, Date.now()); return; }
  accounts.clearLimited(t.account);
  const msg: string = p['last-assistant-message'] || '';
  const codexRefusal = t.role !== 'controller' && t.transcript ? lastCodexRefusal(t.transcript, lastCodexEvent.get(t.id) || store.launchedAt.get(t.id) || 0) : null;
  if (codexRefusal) { recordCommandRefusal(t, codexRefusal, 'Codex'); lastCodexEvent.set(t.id, Date.now()); return; }
  // Codex also runs a short internal turn to name the conversation; its reply is JSON like {"title": "..."}.
  if (/^\s*\{\s*"title"\s*:/.test(msg)) return;
  // Codex sends no event for /new. A turn that ends in another thread shows it, one turn late. The transcript is the old
  // thread's rollout file, so it is cleared and the watcher (index.ts reconcile) looks up the new thread's file.
  const thread: string | undefined = p['thread-id'];
  if (t.sessionId && thread && thread !== t.sessionId) {
    // Codex also ends turns in background threads that have no session file. One answered about the handoff file of
    // the controller (codex-cli 0.160.0); taking it as /new hid every later event of the real conversation. Only a
    // thread with its own session file is a new conversation.
    if (!transcriptFor('codex', thread, (accounts.get(t.account) || accounts.defaultFor('codex')).dir)) return;
    store.update(t.id, { ...clearedPatch(t, thread, '/new'), transcript: undefined });
  }
  // questions Codex asked during the turn can still be open on screen; codexQuestionCheck sets the status when they close
  const status = codexQuestionsOpen(store.get(t.id)!) ? {} : { ...finishedStatus(t, msg), statusSource: `Codex notify (agent-turn-complete) at ${clock()}.` };
  store.update(t.id, { sessionId: p['thread-id'] || t.sessionId, ...status, ...agentErrors.turnEnded(store.get(t.id)!), now: firstPara(msg) || t.now });
  if (msg) store.appendLog(t.id, { did: logDid(msg), wait: endsWithQuestion(msg) ? lastSentence(msg) : 'Nothing.' });
  lastCodexEvent.set(t.id, Date.now());
}

export function recordCommandRefusal(t: Task, refusal: CommandRefusal, source: string) {
  if (t.role === 'controller' || !refusal.command || !refusal.id) return;
  const canPermit = permits.canPermitRefusal(t, refusal);
  const next = refusal.toolName && refusal.toolName !== 'Bash'
    ? `Taskboard cannot run ${refusal.toolName} with a shell permit. Do not retry this tool call. Use an allowed path or ask the user to do this step.`
    : 'Use the dashboard to review the refused command. If no permit is available, use an allowed path or ask the user to do this step.';
  if (!approvals.hasRefusal(t.id, refusal.id)) {
    approvals.request({ actor: t.id, action: 'tool-refusal', summary: `review refused command for task #${t.num}`,
      // the card itself says what the user can do (web/src/refusalText.ts); `next` is guidance for the agent
      detail: `Tool: ${refusal.toolName || 'shell command'}\nCommand: ${refusal.command}\nWorking directory: ${refusal.cwd || t.cwd}\nReason: ${refusal.reason}`, payload: { ...refusal, canPermit } },
      async () => next);
    if (refusal.toolName && refusal.toolName !== 'Bash') {
      try { docs.uploadSystem(t.id, `refusal-${refusal.id}.md`, `# Refused tool call\n\n${next}\n`); }
      catch (e) { console.error('could not send refusal guidance', e); }
    }
  }
  store.update(t.id, { status: 'needs-you', ask: `Refused: ${refusal.command.slice(0, 140)}. Reason: ${refusal.reason}.`,
    statusSource: `${source} refused a tool call at ${clock()}. ${next}` });
}

export const lastCodexEvent = new Map<string, number>();

// Antigravity (agy) hooks, from the Taskboard plugin (server/hooks/agy-hook.mjs). agy has no prompt-submitted,
// notification or permission event. A turn starts with PreInvocation (invocationNum 0: the first model call after a
// prompt) and ends with Stop (fullyIdle true). An approval question has no event; the watcher reads it from the screen
// while the task is working (agyApprovalCheck), and PostToolUse ends it. A Stop hook that answers {decision: "continue", reason}
// makes agy run again with the reason as input (observed with agy 1.2.12); an empty answer lets it stop.
// As for Codex, Taskboard writes the log entry from the first paragraph of the last reply: in agy's default mode each
// shell command and file write needs an approval, and a log entry written by the agent needed about 4 of them a turn.
export const agyPendingTool = new Map<string, string>(); // task id -> the tool call that has no PostToolUse yet
function describeAgyTool(tc: any): string {
  const a = tc?.args || {};
  const oneLine = (x: string) => { const l = String(x).trim().split('\n'); return l[0].slice(0, 160) + (l.length > 1 || l[0].length > 160 ? ' …' : ''); };
  if (a.CommandLine) return `Run: ${oneLine(a.CommandLine)}`;
  const file = a.TargetFile || a.AbsolutePath || a.FilePath || a.Path;
  return file ? `${tc?.name} ${file}` : String(tc?.name || 'a tool');
}
export function antigravityEvent(taskId: string, ev: string, input: any): { output?: unknown } {
  const t = store.get(taskId); if (!t || t.status === 'archived' || !acceptsEvent(t, 'antigravity', input.conversationId)) return {};
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
        agyPendingTool.delete(t.id);
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
        if (/rate|limit|quota|exhaust|billing|credits/i.test(err)) accounts.markLimited(t.account || accounts.defaultFor(t.agent).id, `${err.slice(0, 80)} on #${t.num}`);
        store.update(t.id, { status: 'stopped', stopReason: err.slice(0, 200), statusSource: `Antigravity Stop hook at ${clock()}: ${input.terminationReason || 'error'}.` });
        break;
      }
      // agy has no event that adds context to a prompt: files that arrived in the inbox are passed on here instead
      // (also for the controller on Antigravity, which gets no other hook text)
      const notice = docs.takeInboxNotice(t.id);
      // and so are queued messages (message-queue.ts hookEvents)
      const messages = messageQueue.takeForHook(t.id, 'Stop', messageQueue.HOOK_ROOM - (notice?.length || 0));
      if (notice || messages) return { output: { decision: 'continue', reason: [notice, messages].filter(Boolean).join('\n\n') } };
      accounts.clearLimited(t.account);
      const msg = (t.transcript ? external.readState('antigravity', t.transcript)?.text : undefined) || '';
      store.update(t.id, { ...finishedStatus(t, msg), now: firstPara(msg) || t.now, statusSource: `Antigravity Stop hook at ${clock()}.` });
      if (msg) store.appendLog(t.id, { did: logDid(msg), wait: endsWithQuestion(msg) ? lastSentence(msg) : 'Nothing.' });
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
  [/Claude in Chrome extension detected/, 'Asks whether Claude may use your own Chrome browser (Claude in Chrome). Answer on the Waiting page or in the terminal.'],
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
// This includes 'review', as Claude's UserPromptSubmit does; finishedStatus sets 'review' again when the turn ends.
export function codexActivity(t: Task, transcriptMtime: number) {
  if (Date.now() - (store.launchedAt.get(t.id) || 0) < 20000) return; // starting or resuming, not working
  const last = Math.max(lastCodexEvent.get(t.id) || 0, Date.parse(t.statusAt) || 0, (store.launchedAt.get(t.id) || 0) + 20000);
  // a question read from the screen stays until the screen no longer shows it (screenCheck, codexQuestionCheck)
  const fromScreen = t.statusSource?.startsWith(SCREEN_SOURCE) || codexQuestionsOpen(t);
  if (transcriptMtime > last + 1500 && ['unread', 'idle', 'needs-you', 'review'].includes(t.status) && !fromScreen) {
    store.update(t.id, { status: 'working', ask: '', statusSource: `Codex transcript changed at ${clock()}.` });
    lastCodexEvent.set(t.id, transcriptMtime);
  }
}

// Codex can ask questions without ending its turn (the request_user_input_async tool). It keeps working, and the
// questions wait above the input box ("? 3 questions" / "shift+← to answer"). No hook fires for them, and the rollout
// file does not record the answers, so the screen is the only place that shows whether they are still open.
const CODEX_QUESTION_SOURCE = 'Codex questions on screen';
export const codexQuestionsOpen = (t: Task) => t.status === 'needs-you' && !!t.statusSource?.startsWith(CODEX_QUESTION_SOURCE);
export function codexQuestionCheck(t: Task, screen: string) {
  const collapsed = screen.match(CODEX_QUESTIONS);
  const opened = screen.match(CODEX_QUESTION_OPEN);
  const m = collapsed || (opened ? [opened[0], opened[2]] : CODEX_ASYNC_OPEN.test(screen) ? ['', '1'] : null);
  if (codexQuestionsOpen(t)) {
    if (m) return;
    // answered or dismissed: the rollout file shows whether the turn is still running
    const r = t.transcript ? external.readState('codex', t.transcript) : null;
    const done = r && ['finished', 'aborted'].includes(r.state);
    store.update(t.id, { ...(done ? finishedStatus(t, r.text || '') : { status: 'working' as const, ask: '' }), statusSource: `Codex questions answered or dismissed (seen at ${clock()}).` });
    return;
  }
  if (!m || !['working', 'unread', 'idle', 'review'].includes(t.status)) return;
  const titles = t.transcript ? external.codexQuestions(t.transcript) : [];
  const n = Number(m[1]);
  const ask = `Codex asked ${n} question${n === 1 ? '' : 's'} and keeps working${titles.length ? `: ${titles.join(' / ')}` : '.'} Answer in the terminal (shift+←).`;
  store.update(t.id, { status: 'needs-you', ask, statusSource: `${CODEX_QUESTION_SOURCE} at ${clock()} (request_user_input_async sends no event).` });
}
