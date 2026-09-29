// Turning hook events into task status. Status must be trustworthy, so each rule is tied to a specific event.
import { statSync } from 'node:fs';
import * as docs from './docs.ts';
import * as review from './review.ts';
import * as accounts from './accounts.ts';
import * as external from './external.ts';
import * as store from './store.ts';
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
    now: undefined, stopReason: undefined, interrupted: undefined,
    statusSource: `Conversation cleared (${how}) at ${clock()}.`,
  };
}

export function claudeEvent(taskId: string, input: any): { output?: unknown } {
  const t = store.get(taskId); if (!t) return {};
  // an archived task stays archived whatever its agent still reports
  if (t.status === 'archived') return {};
  const ev = input.hook_event_name;
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
  // Codex sends no event for /new. A turn that ends in another thread shows it, one turn late. The transcript is the old
  // thread's rollout file, so it is cleared and the watcher (index.ts reconcile) looks up the new thread's file.
  const thread: string | undefined = p['thread-id'];
  if (t.sessionId && thread && thread !== t.sessionId) store.update(t.id, { ...clearedPatch(t, thread, '/new'), transcript: undefined });
  // questions Codex asked during the turn can still be open on screen; codexQuestionCheck sets the status when they close
  const status = codexQuestionsOpen(store.get(t.id)!) ? {} : { ...finishedStatus(t, msg), statusSource: `Codex notify (agent-turn-complete) at ${clock()}.` };
  store.update(t.id, { sessionId: p['thread-id'] || t.sessionId, ...status, now: firstPara(msg) || t.now });
  if (msg) store.appendLog(t.id, { did: firstPara(msg).slice(0, 200), wait: endsWithQuestion(msg) ? lastSentence(msg) : 'Nothing.' });
  lastCodexEvent.set(t.id, Date.now());
}

export const lastCodexEvent = new Map<string, number>();

// Some questions appear before any hook can fire, for example "Do you trust this folder?" the first time
// an agent runs in a new folder. For a minute after launch the watcher reads the screen and flags these.
const SCREEN_QUESTIONS: [RegExp, string][] = [
  [/trust this folder|Do you trust the (files|contents)/i, 'Asks whether to trust this folder (first run here). Answer in the terminal.'],
  [/Select login method|Please log in|Sign in with ChatGPT/i, 'Asks you to sign in. Answer in the terminal.'],
  [/Update available[\s\S]*(Update now|Skip)/i, 'Offers an update before starting. Answer in the terminal (Skip continues).'],
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
const CODEX_QUESTIONS = /\?\s+(\d+)\s+questions?\b[^\n]*\n[^\n]*to answer/;
const CODEX_QUESTION_SOURCE = 'Codex questions on screen';
export const codexQuestionsOpen = (t: Task) => t.status === 'needs-you' && !!t.statusSource?.startsWith(CODEX_QUESTION_SOURCE);
export function codexQuestionCheck(t: Task, screen: string) {
  const m = screen.match(CODEX_QUESTIONS);
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
