// The questions and dialogs that agents wait on, as one list for the Waiting page, the notification stack, the task
// panel and `tb pending`. Each item knows how its answer goes back to the agent:
//   - hook: Claude Code's PermissionRequest hook waits (index.ts holds the request) until the user answers here, the
//     hook ends, or Claude Code stops the hook because the user answered in the terminal. Observed with 2.1.287:
//     "allow" and "deny" with a message close the dialog; "allow" does not close a plan approval, so a plan is
//     approved with a key on the screen.
//   - keys: a prompt read from the screen (screen-prompts.ts). Before it types, Taskboard reads the screen again and
//     refuses when the prompt is not the one on the card. It types the key that the dialog shows, or moves the
//     highlight with the arrow keys, checks the highlight, and presses Enter. It never presses Enter on a row that
//     the user did not choose.
//   - prompt: a question at the end of a turn; the answer is typed as the next prompt (typeAnswer, then
//     agents.sendTaskText). Before it types, Taskboard checks that the task still waits on this question.
// Only a click on the dashboard answers an item. The controller answers only what controllerRule allows.
// Items live in memory: a held hook request does not survive a restart, and a screen prompt is read again.
import { randomUUID } from 'node:crypto';
import { parsePrompt, type Risk, type ScreenPrompt } from './screen-prompts.ts';
import type { Task } from './store.ts';
import * as dismissed from './dismiss.ts';

export type PendingKind = 'command' | 'choice' | 'text' | 'dialog' | 'plan' | 'signin' | 'unknown';
export type PendingSource = 'claude-hook' | 'screen' | 'turn-end';
export interface PendingOption { key: string; label: string; description?: string; send: string; risk?: Risk; deny?: boolean; selected?: boolean }
export interface PendingQuestion { question: string; header?: string; options: { label: string; description?: string }[]; multiSelect: boolean }
export interface PendingItem {
  id: string; taskId: string; taskNum: number; taskTitle: string; agent: Task['agent'];
  kind: PendingKind; source: PendingSource; name?: string;
  question: string; header?: string;
  options: PendingOption[];
  // a text box: the answer itself (text), a message sent with the deny option (deny), or plan feedback (change)
  text?: { mode: 'answer' | 'deny' | 'change'; placeholder: string; send: string };
  questions?: PendingQuestion[];        // AskUserQuestion with several questions or a multiple choice: a form
  details?: { command?: string; cwd?: string; reason?: string; title?: string; plan?: string };
  screen?: { hash: string; excerpt: string; partial?: boolean };
  answerable: boolean;
  createdAt: string;
  state: 'pending' | 'sending' | 'answered' | 'gone' | 'failed';
  result?: string;
  needsTerminal?: boolean;              // the last answer failed, and the user must act in the terminal
  reason?: string;
  inspect?: boolean;
  answer?: { by: 'user' | 'controller'; label: string; sent: string; at: string; rule?: string; tasks?: number[] };
  repeats?: { count: number; lastAnswer: string };
  sameIn?: { id: string; taskId: string; taskNum: number }[];
  sig?: string;                          // the signature of a dismiss (dismiss.ts itemSignature)
  dismissed?: { at: string; until?: string };  // set while the user has dismissed this item (dismiss.ts)
}

type Action = { via: 'hook'; output: (text: string) => unknown } | { via: 'keys'; index: number; expect?: string } | { via: 'prompt' } | { via: 'codex-text' };
interface Live { item: PendingItem; actions: Map<string, Action>; textAction?: Action; resolve?: (output: unknown) => void; signature: string; hook?: { tool: string; input: string } }

export interface Io {
  capture: (session: string) => Promise<string>;
  key: (session: string, key: string, literal: boolean) => Promise<void>;
  cancelCopyMode: (session: string) => Promise<void>;
  // types the answer to a question at the end of a turn (agents.sendTaskText with answer: true). It throws
  // NotTyped (deliver-text.ts, with a state) when it typed nothing.
  sendText: (t: Task, text: string) => Promise<{ submitted: boolean; warning?: string }>;
  getTask: (id: string) => Task | undefined;
  log: (t: Task, did: string) => void;
  answered: (t: Task, note: string) => void;
  wait: (ms: number) => Promise<void>;
  // Shares the task's input lock with message delivery and holds dashboard terminal keys.
  withInput?: <T>(t: Task, fn: () => Promise<T>) => Promise<T>;
}
let io: Io;
export const setIo = (x: Io) => { io = x; };

const isCodexQuestion = (name?: string) => name === 'codex-question' || name === 'codex-async-question';
const live = new Map<string, Live>();
// Keep one receipt while Codex still shows a screen where Enter was attempted.
const submittedScreens = new Map<string, string>();
const history: PendingItem[] = [];               // answered and closed items, newest first, for the Answered view
const listeners = new Set<() => void>();
export const onPendingChange = (fn: () => void) => { listeners.add(fn); };
let emitTimer: NodeJS.Timeout | undefined;
const emit = () => { clearTimeout(emitTimer); emitTimer = setTimeout(() => listeners.forEach(f => f()), 30); };
const clock = () => new Date().toTimeString().slice(0, 5);

function close(l: Live, state: 'answered' | 'gone' | 'failed', result: string) {
  live.delete(l.item.id);
  l.item.state = state; l.item.result = result;
  history.unshift(l.item); history.splice(60);
  // an answer is something new for the item: a later card with the same text shows again
  if (state === 'answered' && l.item.sig) dismissed.bringBack(l.item.sig);
  delete l.item.dismissed;
  l.resolve?.(undefined); l.resolve = undefined;
  emit();
}
const signatureOf = (i: Pick<PendingItem, 'agent' | 'kind' | 'question' | 'details' | 'options'>) =>
  [i.agent, i.kind, i.question, i.details?.command || '', ...i.options.map(o => o.label)].join('\u0000');

function add(t: Task, base: Omit<PendingItem, 'id' | 'taskId' | 'taskNum' | 'taskTitle' | 'agent' | 'createdAt' | 'state'>, actions: Map<string, Action>, textAction?: Action, resolve?: (o: unknown) => void): Live {
  const item: PendingItem = { ...base, id: randomUUID().slice(0, 8), taskId: t.id, taskNum: t.num, taskTitle: t.title, agent: t.agent, createdAt: new Date().toISOString(), state: 'pending' };
  const signature = signatureOf(item);
  // the same prompt in the same task came back after an answer in the last hour
  const before = history.find(h => h.taskId === t.id && h.state === 'answered' && signatureOf(h) === signature && Date.now() - Date.parse(h.answer?.at || h.createdAt) < 3600_000);
  if (before) item.repeats = { count: (before.repeats?.count || 1) + 1, lastAnswer: `"${before.answer?.label}" at ${new Date(before.answer!.at).toTimeString().slice(0, 5)}` };
  const l: Live = { item, actions, textAction, resolve, signature };
  live.set(item.id, l); emit(); return l;
}

// ---------- Claude Code PermissionRequest hook ----------
// the words of option 2 on the screen, from the permission_suggestions of the hook input
const MODE_NAME: Record<string, string> = { acceptEdits: 'accept edits', bypassPermissions: 'bypass permissions', plan: 'plan', default: 'default' };
const describeSuggestion = (s: any): string => {
  if (s?.type === 'addRules') return `always allow ${(s.rules || []).map((r: any) => r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName).join(', ')}`;
  if (s?.type === 'addDirectories') return `always allow access to ${(s.directories || []).join(', ')}`;
  if (s?.type === 'setMode') return `switch to ${MODE_NAME[s.mode] || s.mode} mode for this session`;
  return `add ${String(s?.type || 'a rule')}`;
};
const decision = (d: object) => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d } });
const DENIED = 'The user denied this on the Taskboard Waiting page.';

// Returns the hook output when the user answers here, or undefined (no decision: the dialog stays in the terminal).
// `closed` registers the callback for a hook request that ended before an answer.
export function holdClaude(t: Task, input: any, closed: (fn: () => void) => void, maxMs: number): Promise<unknown> {
  return new Promise(resolve => {
    const tool = String(input.tool_name || 'a tool'); const ti = input.tool_input || {};
    const actions = new Map<string, Action>();
    let base: Parameters<typeof add>[1]; let textAction: Action | undefined;
    if (tool === 'AskUserQuestion' && Array.isArray(ti.questions) && ti.questions.length) {
      const questions: PendingQuestion[] = ti.questions.map((q: any) => ({ question: String(q.question || ''), header: q.header, multiSelect: !!q.multiSelect,
        options: (q.options || []).map((o: any) => ({ label: String(o.label || ''), description: o.description })) }));
      const answerWith = (answers: Record<string, string>) => decision({ behavior: 'allow', updatedInput: { ...ti, answers } });
      if (questions.length === 1 && !questions[0].multiSelect) {
        const q = questions[0];
        q.options.forEach((o, i) => actions.set(`o${i}`, { via: 'hook', output: () => answerWith({ [q.question]: o.label }) }));
        textAction = { via: 'hook', output: text => answerWith({ [q.question]: text }) };
        base = { kind: 'choice', source: 'claude-hook', question: q.question, header: q.header, answerable: true,
          options: q.options.map((o, i) => ({ key: `o${i}`, label: o.label, description: o.description, send: `hook: answer "${o.label}"` })),
          text: { mode: 'answer', placeholder: 'Or type your own answer ("Type something").', send: 'hook: answer with your text' } };
      } else {
        // the form posts one answer for each question; a multiple choice is sent as the labels joined by ", " (observed)
        actions.set('form', { via: 'hook', output: text => answerWith(JSON.parse(text)) });
        base = { kind: 'choice', source: 'claude-hook', question: questions.length === 1 ? questions[0].question : `${questions.length} questions`, answerable: true, questions, options: [] };
      }
    } else if (tool === 'ExitPlanMode') {
      // approval: the key on the screen (a hook "allow" does not close this dialog); feedback: hook deny with the text
      actions.set('auto', { via: 'keys', index: 0, expect: 'claude-plan' });
      actions.set('manual', { via: 'keys', index: 1, expect: 'claude-plan' });
      textAction = { via: 'hook', output: text => decision({ behavior: 'deny', message: text }) };
      base = { kind: 'plan', source: 'claude-hook', question: 'Claude has written up a plan and is ready to execute. Would you like to proceed?', answerable: true,
        details: { plan: String(ti.plan || '') },
        options: [{ key: 'auto', label: '1. Yes, auto-accept edits', send: 'keys: 1 (after a screen check)' }, { key: 'manual', label: '2. Yes, manually approve edits', send: 'keys: 2 (after a screen check)' }],
        text: { mode: 'change', placeholder: '3. Tell Claude what to change', send: 'hook: deny with your text (Claude changes the plan and asks again)' } };
    } else {
      const suggestions: any[] = Array.isArray(input.permission_suggestions) ? input.permission_suggestions : [];
      actions.set('once', { via: 'hook', output: () => decision({ behavior: 'allow' }) });
      if (suggestions.length) actions.set('always', { via: 'hook', output: () => decision({ behavior: 'allow', updatedPermissions: suggestions }) });
      actions.set('no', { via: 'hook', output: text => decision({ behavior: 'deny', message: text.trim() || DENIED }) });
      const command = tool === 'Bash' ? String(ti.command || '') : String(ti.file_path || ti.url || ti.path || ti.pattern || '') || undefined;
      base = { kind: 'command', source: 'claude-hook', question: tool === 'Bash' ? `Bash command: ${ti.description || 'run a command'}` : ti.description ? `${tool}: ${ti.description}` : ti.file_path ? `${tool} ${String(ti.file_path).split('/').pop()}` : `Use ${tool}`, answerable: true,
        details: { command, cwd: input.cwd, title: tool },
        options: [
          { key: 'once', label: '1. Yes', send: 'hook: allow (this call only)' },
          ...(suggestions.length ? [{ key: 'always', label: `2. Yes, and ${suggestions.map(describeSuggestion).join(', and ')}`, send: 'hook: allow and add the rule', risk: 'wide-access' as Risk }] : []),
          { key: 'no', label: `${suggestions.length ? 3 : 2}. No`, send: 'hook: deny with your message', deny: true },
        ],
        text: { mode: 'deny', placeholder: 'Optional: tell the agent why, or what to do instead. Sent with "No".', send: 'with "No"' } };
    }
    let done = false;
    const finish = (out: unknown) => { if (done) return; done = true; clearTimeout(timer); resolve(out); };
    const l = add(t, base, actions, textAction, finish);
    l.hook = { tool, input: JSON.stringify(ti) };
    const timer = setTimeout(() => { if (live.has(l.item.id)) close(l, 'gone', 'Taskboard stopped waiting for the hook. The dialog stays in the terminal.'); finish(undefined); }, maxMs);
    closed(() => { if (live.has(l.item.id) && l.item.state === 'pending') close(l, 'gone', 'The agent closed this question: it was answered in the terminal, or the hook timed out.'); finish(undefined); });
  });
}

// Claude Code stops the hook when the user answers "No" in the terminal, but not after "Yes" (observed with 2.1.287):
// the hook keeps running, and Claude Code shows the next permission dialog only after it ends. So a held hook is
// released (no decision) when its tool ran (PostToolUse with the same tool and input), or when the turn moved on.
export function releaseClaude(taskId: string, ran?: { tool_name?: string; tool_input?: unknown }) {
  const held = [...live.values()].filter(l => l.item.taskId === taskId && l.hook && l.item.state === 'pending');
  const pick = ran ? (held.filter(l => l.hook!.tool === ran.tool_name && l.hook!.input === JSON.stringify(ran.tool_input || {}))
    .concat(held.filter(l => l.hook!.tool === ran.tool_name)).slice(0, 1)) : held;
  for (const l of pick) close(l, 'gone', ran ? 'Answered in the terminal: the tool ran.' : 'The agent moved on: answered in the terminal.');
}

// ---------- screen prompts and end-of-turn questions ----------
const hasHook = (taskId: string) => [...live.values()].some(l => l.item.taskId === taskId && l.item.source === 'claude-hook' && l.item.state !== 'gone');
const openFor = (taskId: string, source?: PendingSource) => [...live.values()].filter(l => l.item.taskId === taskId && (!source || l.item.source === source));
export const hasOpen = (taskId: string) => openFor(taskId).length > 0;

function screenItem(t: Task, p: ScreenPrompt) {
  const actions = new Map<string, Action>();
  const options: PendingOption[] = p.options.map((o, i) => {
    actions.set(`o${i}`, { via: 'keys', index: i });
    const send = isCodexQuestion(p.name) ? `Select "${o.label}", then Enter` : o.key ? `keys: ${o.key}` : i === p.selected ? 'keys: Enter (this row is selected)' : `keys: ${i > p.selected ? '↓' : '↑'} ×${Math.abs(i - Math.max(p.selected, 0))}, then Enter`;
    return { key: `o${i}`, label: o.label, description: o.description, send, ...(o.risk ? { risk: o.risk } : {}), ...(i === p.selected ? { selected: true } : {}) };
  });
  const kind: PendingKind = p.kind;
  add(t, { kind, source: 'screen', name: p.name, question: p.question,
    options: p.answerable ? options.filter(o => !isCodexQuestion(p.name) || Number(o.key.slice(1)) !== p.textOption) : [], answerable: p.answerable,
    reason: p.reason, inspect: p.inspect,
    ...(p.answerable && p.textAnswer ? { text: { mode: 'answer' as const, placeholder: 'Type your exact answer.', send: 'Your text in the Codex answer field, then Enter' } } : {}),
    details: Object.keys(p.details).length ? p.details : undefined, screen: { hash: p.hash, excerpt: p.excerpt, ...(p.partial ? { partial: true } : {}) } }, actions, p.textAnswer ? { via: 'codex-text' } : undefined);
}

export async function inspect(id: string): Promise<PendingItem> {
  const l = live.get(id);
  if (!l || l.item.state !== 'pending' || !l.item.inspect) throw new AnswerError('This card no longer has a collapsed question.');
  const t = io.getTask(l.item.taskId);
  if (!t || t.openElsewhere || t.status !== 'needs-you') throw new AnswerError('The task no longer waits here. Open terminal to check it.');
  l.item.state = 'sending'; emit();
  try {
    const run = async () => {
      await io.cancelCopyMode(t.session);
      const p = parsePrompt(t.agent, await io.capture(t.session));
      if (!p?.inspect || p.hash !== l.item.screen?.hash) throw new OutOfDate('This card is out of date. The collapsed question changed. Taskboard pressed no keys.');
      await io.key(t.session, 'S-Left', false);
      for (let n = 0; n < 8; n++) {
        await io.wait(150);
        const next = parsePrompt(t.agent, await io.capture(t.session));
        if (next && isCodexQuestion(next.name)) {
          close(l, 'gone', 'Opened the Codex question.');
          screenItem(t, next);
          return openFor(t.id, 'screen')[0].item;
        }
      }
      throw new AnswerError('Codex did not show a readable question after Shift+Left. Open terminal and check its question controls.', 409, true);
    };
    return await (io.withInput ? io.withInput(t, run) : run());
  } catch (e) {
    if (e instanceof OutOfDate) close(l, 'gone', e.message);
    else { l.item.state = 'pending'; l.item.inspect = false; l.item.reason = e instanceof Error ? e.message : String(e); emit(); }
    throw e;
  }
}

const TURN_END = /Stop hook|agent-turn-complete|Antigravity Stop hook/;
// Called by the watcher (index.ts reconcile) with the visible screen of a task that waits on the user, or that has an
// open item. It adds, keeps or closes the items of this task.
export function scan(t: Task, screen: string) {
  const waiting = t.status === 'needs-you';
  if (waiting && hasHook(t.id)) return; // the hook item describes the dialog; the hook ending closes it
  let p = waiting ? parsePrompt(t.agent, screen.split('\n').slice(-45).join('\n')) : null;
  const submitted = submittedScreens.get(t.id);
  if (submitted && p?.hash !== submitted) submittedScreens.delete(t.id);
  if (p && submitted === p.hash) {
    p = { ...p, answerable: false, reason: 'Taskboard already pressed Enter for this question. Open terminal to check whether Codex received it.' };
  }
  for (const l of openFor(t.id, 'screen')) {
    if (l.item.state !== 'pending') continue;
    if (p && p.hash === l.item.screen?.hash && (p.answerable === l.item.answerable || l.item.needsTerminal)) { if (l.item.screen.excerpt !== p.excerpt) { l.item.screen.excerpt = p.excerpt; emit(); } continue; }
    close(l, 'gone', 'The prompt is no longer on the screen: it was answered in the terminal, or it changed.');
  }
  if (p && !openFor(t.id, 'screen').length && !hidden.get(t.id)?.has(p.hash)) screenItem(t, p);
  // a question at the end of a turn, when no dialog is on the screen
  const question = waiting && !p && TURN_END.test(t.statusSource || '') && /\?\s*$/.test(t.ask || '') ? t.ask!.trim() : '';
  for (const l of openFor(t.id, 'turn-end')) if (l.item.state === 'pending' && l.item.question !== question) close(l, 'gone', 'The task no longer waits on this question.');
  if (question && !openFor(t.id, 'turn-end').length) {
    add(t, { kind: 'text', source: 'turn-end', question, options: [], answerable: true,
      text: { mode: 'answer', placeholder: 'Type your answer. Taskboard types it into the input box and presses Enter.', send: 'prompt: typed into the input box, then Enter' } },
      new Map(), { via: 'prompt' });
  }
}
// "Not a question": close the card and do not show this screen again for the task
const hidden = new Map<string, Set<string>>();
export function hide(id: string) {
  const l = live.get(id); if (!l || l.item.source !== 'screen') throw new AnswerError('Only a card read from the screen can be hidden.', 400);
  if (l.item.state !== 'pending') throw new AnswerError('This card is being answered now.');
  const set = hidden.get(l.item.taskId) || new Set<string>(); set.add(l.item.screen!.hash); hidden.set(l.item.taskId, set);
  close(l, 'gone', 'Hidden by the user: not a question.');
}
// a task that was archived, removed or moved: its items close
export function forgetTask(taskId: string) { submittedScreens.delete(taskId); for (const l of openFor(taskId)) close(l, 'gone', 'The task was closed.'); }

// ---------- list ----------
export function list(): PendingItem[] {
  const open = [...live.values()];
  for (const l of open) {
    const same = open.filter(o => o !== l && o.item.state === 'pending' && o.signature === l.signature && o.item.answerable);
    l.item.sameIn = same.length && l.item.answerable ? same.map(o => ({ id: o.item.id, taskId: o.item.taskId, taskNum: o.item.taskNum })) : undefined;
    l.item.sig = dismissed.itemSignature(l.item, l.signature);
    const d = dismissed.entryFor(l.item.sig);
    l.item.dismissed = d ? { at: d.at, ...(d.until ? { until: d.until } : {}) } : undefined;
  }
  return open.map(l => l.item).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export const answeredList = () => history.slice(0, 40);
// a held Claude hook card: its dismiss lasts dismiss.HOOK_MS only (the agent waits on the answer)
export const holdsHook = (item: PendingItem) => item.source === 'claude-hook';
export const get = (id: string) => live.get(id)?.item || history.find(h => h.id === id);

// ---------- answers ----------
// confirmRisk: the machine setting (machine.ts) for the user's clicks. Without it, every option with a risk needs confirm.
export interface AnswerInput { option?: string; text?: string; confirm?: boolean; group?: string[]; by: 'user' | 'controller'; rule?: string; confirmRisk?: Partial<Record<RiskKey, boolean>> }
type RiskKey = 'wideAccess' | 'installs' | 'spends' | 'exits';
const RISK_KEY: Record<Risk, RiskKey> = { 'wide-access': 'wideAccess', installs: 'installs', spends: 'spends', exits: 'exits' };
// true when a user click on an option with this risk must come with the confirm step
export const needsConfirm = (risk: Risk, confirmRisk?: AnswerInput['confirmRisk']) => confirmRisk?.[RISK_KEY[risk]] !== false;
export class AnswerError extends Error { constructor(message: string, public status = 409, public terminal = false) { super(message); } }
// the card no longer shows what the task waits on: answer() removes it
class OutOfDate extends AnswerError {}

async function typeKeys(t: Task, l: Live, index: number, expect?: string): Promise<string> {
  await io.cancelCopyMode(t.session);
  const read = async () => parsePrompt(t.agent, (await io.capture(t.session)).split('\n').slice(-45).join('\n'));
  const p = await read();
  if (!p || (expect ? p.name !== expect : p.hash !== l.item.screen?.hash))
    throw new AnswerError('The prompt on the screen is not the one on this card any more. Taskboard typed nothing.', 409, isCodexQuestion(l.item.name));
  if (submittedScreens.get(t.id) === p.hash) throw new AnswerError('Taskboard already attempted this answer. Open terminal to check it.', 409, true);
  if (!p.answerable || !p.options[index]) throw new AnswerError('Taskboard cannot answer this prompt. Taskboard typed nothing.', 409, true);
  const opt = p.options[index];
  const after = async (sent: string) => {
    await io.wait(1000);
    const now = await read();
    return now && now.hash === p.hash ? `${sent} (the prompt still shows on the screen: check the terminal)` : sent;
  };
  if (opt.key) {
    const named = /^(Escape|Enter|Up|Down)$/.test(opt.key);
    await io.key(t.session, opt.key, !named);
    return after(`keys: ${opt.key}`);
  }
  // move the highlight one row at a time, then check that it is on the chosen row before Enter
  if (p.selected < 0) throw new AnswerError('No row is highlighted on the screen. Taskboard typed nothing.');
  const moves: string[] = [];
  for (let n = 0, sel = p.selected; sel !== index && n < 12; n++) {
    const k = index > sel ? 'Down' : 'Up';
    await io.key(t.session, k, false); moves.push(k === 'Down' ? '↓' : '↑');
    await io.wait(150);
    const now = await read();
    if (!now || now.hash !== p.hash || !now.answerable) throw new AnswerError(`The prompt changed after ${moves.join('')}. Enter was not pressed. Check the terminal.`, 409, true);
    sel = now.selected;
  }
  const check = await read();
  if (!check || check.hash !== p.hash || !check.answerable || check.selected !== index) throw new AnswerError(`The highlight is not on "${opt.label}". Enter was not pressed. Check the terminal.`, 409, true);
  if (isCodexQuestion(p.name)) submittedScreens.set(t.id, p.hash);
  await io.key(t.session, 'Enter', false);
  const sent = await after(`keys: ${[...moves, 'Enter'].join(' ')}`);
  if (isCodexQuestion(p.name) && sent.includes('prompt still shows')) throw new AnswerError('Taskboard pressed Enter, but Codex still shows this question. Open terminal to check it. Taskboard will not send it again.', 409, true);
  return sent;
}

async function typeCodexText(t: Task, l: Live, text: string): Promise<string> {
  // A short single line stays visible as exact text, rather than a paste placeholder.
  if (text.length > 100 || /[\r\n\x00-\x1f\x7f]/.test(text)) throw new AnswerError('Use up to 100 characters on one line, or open terminal for a longer answer.', 400);
  await io.cancelCopyMode(t.session);
  const read = async () => parsePrompt('codex', await io.capture(t.session));
  let p = await read();
  if (p && submittedScreens.get(t.id) === p.hash) throw new AnswerError('Taskboard already attempted this answer. Open terminal to check it.', 409, true);
  if (!p || !isCodexQuestion(p.name) || p.hash !== l.item.screen?.hash || !p.answerable || !p.textAnswer)
    throw new OutOfDate('This card is out of date. The question or answer field changed. Taskboard typed nothing.');
  if (p.options.length) {
    const other = p.textOption ?? -1;
    if (other < 0) throw new AnswerError('Codex has no text answer option. Open terminal.', 409, true);
    for (let n = 0; p.selected !== other && n < 12; n++) {
      await io.key(t.session, p.selected < other ? 'Down' : 'Up', false);
      await io.wait(150);
      const next = await read();
      if (!next || next.hash !== p.hash || !next.answerable) throw new AnswerError('The question changed while selecting the text answer. Enter was not pressed. Open terminal.', 409, true);
      p = next;
    }
    if (p.selected !== other) throw new AnswerError('Codex did not select the text answer. Enter was not pressed. Open terminal.', 409, true);
    if (p.name === 'codex-question') {
      await io.key(t.session, 'Tab', false);
      await io.wait(150);
    }
  }
  const before = await read();
  const emptyField = before && (p.name === 'codex-question'
    ? /^\s*›\s*(Add notes|Type your answer \(optional\))\s*$/m.test(before.excerpt)
    : p.options.length ? before.selected === p.textOption : /^\s*›\s*Type your answer\s*$/m.test(before.excerpt));
  if (!before || before.hash !== p.hash || before.notes || !emptyField)
    throw new AnswerError('Codex did not show an empty answer field. Taskboard typed no text. Open terminal.', 409, true);
  await io.key(t.session, text, true);
  await io.wait(600);
  const check = await read();
  if (!check || check.hash !== p.hash || check.notes !== text || (p.options.length && check.selected !== p.selected))
    throw new AnswerError('The answer field does not show your exact text. Enter was not pressed. Open terminal and check the text.', 409, true);
  submittedScreens.set(t.id, p.hash);
  await io.key(t.session, 'Enter', false);
  await io.wait(1000);
  if ((await read())?.hash === p.hash) throw new AnswerError('Taskboard pressed Enter, but Codex still shows this question. Open terminal to check it. Taskboard will not send it again.', 409, true);
  return `answer field: "${text}" + Enter`;
}

async function sendOne(l: Live, input: AnswerInput): Promise<string> {
  const t = io.getTask(l.item.taskId);
  if (!t) throw new AnswerError('The task is gone.', 404);
  const opt = input.option ? l.item.options.find(o => o.key === input.option) : undefined;
  const action = input.option === 'form' ? l.actions.get('form') : opt ? l.actions.get(opt.key) : l.textAction;
  if (!action) throw new AnswerError('This answer does not exist for this card.', 400);
  const text = (input.text || '').slice(0, 8000);
  if (!opt && input.option !== 'form' && !text.trim()) throw new AnswerError('Type an answer first.', 400);
  if (action.via === 'hook') {
    if (!l.resolve) throw new AnswerError('The agent no longer waits for this hook.');
    l.resolve(action.output(text)); l.resolve = undefined;
    return opt ? opt.send.replace('your message', text.trim() ? `"${text.trim()}"` : 'the default message') : input.option === 'form' ? `hook: answers ${text}` : `hook: "${text}"`;
  }
  if (action.via === 'keys' || action.via === 'codex-text') {
    if (t.openElsewhere || ['archived', 'parked', 'suspended', 'stopped'].includes(t.status)) throw new AnswerError('The task cannot accept an answer here. Open terminal and check its session.', 409, true);
    const run = () => action.via === 'keys' ? typeKeys(t, l, action.index, action.expect) : typeCodexText(t, l, text);
    try { return await (io.withInput ? io.withInput(t, run) : run()); }
    catch (e) {
      if (isCodexQuestion(l.item.name) && !(e instanceof AnswerError) && (e as { state?: string })?.state !== 'busy')
        throw new AnswerError(`Taskboard could not complete the screen answer. Open terminal and check the question before sending again. ${e instanceof Error ? e.message : String(e)}`, 409, true);
      throw e;
    }
  }
  return typeAnswer(l, text);
}

// ---------- the answer to a question at the end of a turn ----------
// Why the task no longer waits on the question of this card, or '' when it still does. scan() makes the card only
// while the status is "needs you" from the end of a turn with this question, so any other status means a change.
function staleReason(t: Task, question: string): string {
  if (t.status === 'working') return 'the agent started a new turn.';
  if (t.status !== 'needs-you') return 'the task no longer waits on this question.';
  if (!TURN_END.test(t.statusSource || '')) return 'the agent now waits on a dialog or an approval, not on this question.';
  if ((t.ask || '').trim() !== question) return 'the agent asked a newer question.';
  return '';
}
// True when the screen shows the end of the question. Only letters and digits count: the agent draws Markdown
// without its marks and wraps long lines.
const letters = (s: string) => s.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
export const showsQuestion = (screen: string, question: string) => letters(screen.split('\n').slice(-80).join('\n')).includes(letters(question).slice(-60));

// Why nothing was typed, in words for the card, and whether a later try can work. state comes from NotTyped
// (deliver-text.ts): pending.ts does not import it, so the tests run without tmux.
function whyNotTyped(e: unknown): { message: string; retry: boolean; terminal: boolean } {
  const state = (e as { state?: string })?.state;
  if (state === 'question') return { message: 'The terminal shows a dialog or a different question now. Taskboard typed nothing. Open the terminal and answer it there.', retry: false, terminal: true };
  if (state === 'draft') return { message: 'The input box in the terminal holds text that a person typed. Taskboard does not type into it. Open the terminal, then send or clear that text.', retry: false, terminal: true };
  if (state === 'no-box') return { message: `The terminal did not show an empty input box within ${ANSWER_TRIES * ANSWER_GAP_MS / 1000} s. Taskboard typed nothing. Try again, or open the terminal and type the answer there.`, retry: true, terminal: true };
  if (state === 'busy') return { message: 'Taskboard was typing another message into this task. Taskboard typed nothing. Try again in a few seconds.', retry: true, terminal: false };
  return { message: e instanceof Error ? e.message : String(e), retry: false, terminal: true };
}
// The agent can still draw its screen when the card is answered, so a screen that is not ready is read again for a
// few seconds. A dialog or a draft is not read again: it stays until a person acts.
export const ANSWER_TRIES = 8, ANSWER_GAP_MS = 500;
async function typeAnswer(l: Live, text: string): Promise<string> {
  for (let n = 1; ; n++) {
    const t = io.getTask(l.item.taskId);
    if (!t) throw new AnswerError('The task is gone.', 404);
    const stale = staleReason(t, l.item.question);
    if (stale) throw new OutOfDate(`This card is out of date: ${stale} Taskboard typed nothing and removed the card.`);
    let failed: ReturnType<typeof whyNotTyped>;
    if (!showsQuestion(await io.capture(t.session), l.item.question))
      failed = { message: 'Taskboard cannot find this question on the terminal screen. Taskboard typed nothing. Open the terminal and type the answer there.', retry: true, terminal: true };
    else {
      try {
        const r = await io.sendText(t, text);
        if (!r.submitted) throw new AnswerError(r.warning || 'The text was typed, but Enter was not pressed. Check the terminal.', 409, true);
        return `prompt: "${text.length > 80 ? text.slice(0, 77) + '…' : text}" + Enter`;
      } catch (e) {
        if (e instanceof AnswerError) throw e;
        failed = whyNotTyped(e);
      }
    }
    if (!failed.retry || n >= ANSWER_TRIES) throw new AnswerError(failed.message, 409, failed.terminal);
    await io.wait(ANSWER_GAP_MS);
  }
}

export async function answer(id: string, input: AnswerInput): Promise<PendingItem> {
  const l = live.get(id);
  if (!l) { const h = history.find(x => x.id === id); throw new AnswerError(h ? `This card is closed: ${h.result || h.state}.` : 'This card does not exist.', h ? 409 : 404); }
  if (l.item.state !== 'pending') throw new AnswerError('This card is being answered now.');
  if (!l.item.answerable) throw new AnswerError('Taskboard cannot answer this prompt. Open the terminal.', 400);
  const opt = input.option ? l.item.options.find(o => o.key === input.option) : undefined;
  if (input.option && input.option !== 'form' && !opt) throw new AnswerError('This answer does not exist for this card.', 400);
  // the controller never chooses an option with a risk, whatever the confirm setting (controllerRule refuses it first)
  if (opt?.risk && input.by !== 'user') throw new AnswerError('Only the user chooses an option that installs software, gives wide access, asks for credit or ends the session.', 403);
  if (opt?.risk && !input.confirm && needsConfirm(opt.risk, input.confirmRisk)) throw new AnswerError('This option needs the confirm step.', 400);
  const group = (input.group || []).filter(x => x !== id);
  const allowed = new Set((list().find(i => i.id === id)?.sameIn || []).map(s => s.id));
  if (group.some(g => !allowed.has(g))) throw new AnswerError('A task in the group no longer waits on the same prompt. Nothing was sent.');
  const targets = [l, ...group.map(g => live.get(g)!)];
  const label = opt?.label || (input.option === 'form' ? 'the form answers' : 'your text');
  const nums = targets.map(x => x.item.taskNum);
  const errors: string[] = [];
  for (const x of targets) {
    if (x.item.state !== 'pending') { errors.push(`#${x.item.taskNum}: already answered.`); continue; }
    x.item.state = 'sending'; x.item.needsTerminal = undefined; emit();
    try {
      const sent = await sendOne(x, input);
      x.item.answer = { by: input.by, label, sent, at: new Date().toISOString(), rule: input.rule, ...(nums.length > 1 ? { tasks: nums } : {}) };
      const t = io.getTask(x.item.taskId);
      if (t) {
        const who = input.by === 'user' ? 'The user' : `The controller (${input.rule})`;
        const risk = opt?.risk ? ` The option has the risk ${opt.risk}, sent ${input.confirm ? 'after' : 'without'} the confirm step.` : '';
        io.log(t, `${who} answered "${x.item.question.slice(0, 160)}" with "${label}" on the Waiting page${nums.length > 1 ? ` (one answer for ${nums.map(n => '#' + n).join(', ')})` : ''}. Taskboard sent ${sent}.${risk}`);
        // also after a typed answer: until the agent's prompt hook sets "working", scan() would make the card again
        io.answered(t, `Answered on the Waiting page at ${clock()}.`);
      }
      close(x, 'answered', `Sent ${sent}.`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // one target: the card names the task, so the message has no task number
      errors.push(targets.length > 1 ? `#${x.item.taskNum}: ${message}` : message);
      if (e instanceof OutOfDate) { close(x, 'gone', message); continue; }
      x.item.state = 'pending'; x.item.result = message; x.item.needsTerminal = e instanceof AnswerError && e.terminal || undefined;
      // After a partial terminal operation, another click must not type the answer twice.
      if (isCodexQuestion(x.item.name) && x.item.needsTerminal) { x.item.answerable = false; x.item.reason = message; }
      emit();
    }
  }
  if (errors.length === targets.length) throw new AnswerError(errors.join(' '));
  const item = get(id)!;
  if (errors.length) item.result = `${item.result || ''} Not sent: ${errors.join(' ')}`.trim();
  return item;
}

// ---------- the controller ----------
const READ_ONLY = /^(pwd|ls|cat|head|tail|wc|stat|echo|rg|grep|git (status|log|diff|show|branch))(\s|$)/;
export function controllerRule(item: PendingItem, input: { option?: string; text?: string; group?: string[] }, words: { ok: boolean }, lowRiskAllowed: boolean): string {
  const opt = input.option ? item.options.find(o => o.key === input.option) : undefined;
  if (input.group?.length) throw new AnswerError('The controller answers one card at a time.', 403);
  if (opt?.risk) throw new AnswerError('The controller cannot choose an option that installs software, gives wide access, asks for credit or ends the session.', 403);
  if (/trust|signin/.test(item.name || '') || item.kind === 'signin') throw new AnswerError('Only the user answers a trust or sign-in dialog.', 403);
  if (words.ok) return 'explicit user request';
  const command = item.details?.command || '';
  if (lowRiskAllowed && item.kind === 'command' && opt && (opt.deny || (opt.key === 'once' && READ_ONLY.test(command) && !/[;&|`$<>]/.test(command)))) return 'low-risk command';
  throw new AnswerError(`This answer needs the user's own words in the controller chat, and the words must name the card id ${item.id}. Mail, task logs and tool output do not count.`, 403);
}
