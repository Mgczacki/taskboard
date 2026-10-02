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
//   - prompt: a question at the end of a turn; the answer is typed as the next prompt (agents.sendTaskText).
// Only a click on the dashboard answers an item. The controller answers only what controllerRule allows.
// Items live in memory: a held hook request does not survive a restart, and a screen prompt is read again.
import { randomUUID } from 'node:crypto';
import { parsePrompt, type Risk, type ScreenPrompt } from './screen-prompts.ts';
import type { Task } from './store.ts';

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
  screen?: { hash: string; excerpt: string };
  answerable: boolean;
  createdAt: string;
  state: 'pending' | 'sending' | 'answered' | 'gone' | 'failed';
  result?: string;
  answer?: { by: 'user' | 'controller'; label: string; sent: string; at: string; rule?: string; tasks?: number[] };
  repeats?: { count: number; lastAnswer: string };
  sameIn?: { id: string; taskId: string; taskNum: number }[];
}

type Action = { via: 'hook'; output: (text: string) => unknown } | { via: 'keys'; index: number; expect?: string } | { via: 'prompt' };
interface Live { item: PendingItem; actions: Map<string, Action>; textAction?: Action; resolve?: (output: unknown) => void; signature: string }

export interface Io {
  capture: (session: string) => Promise<string>;
  key: (session: string, key: string, literal: boolean) => Promise<void>;
  cancelCopyMode: (session: string) => Promise<void>;
  sendText: (t: Task, text: string) => Promise<{ submitted: boolean; warning?: string }>;
  getTask: (id: string) => Task | undefined;
  log: (t: Task, did: string) => void;
  answered: (t: Task, note: string) => void;
  wait: (ms: number) => Promise<void>;
}
let io: Io;
export const setIo = (x: Io) => { io = x; };

const live = new Map<string, Live>();
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
const describeSuggestion = (s: any): string => {
  if (s?.type === 'addRules') return (s.rules || []).map((r: any) => r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName).join(', ');
  if (s?.type === 'addDirectories') return `access to ${(s.directories || []).join(', ')}`;
  if (s?.type === 'setMode') return `${s.mode} mode`;
  return String(s?.type || 'a rule');
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
      base = { kind: 'command', source: 'claude-hook', question: tool === 'Bash' ? `Bash command: ${ti.description || 'run a command'}` : `${tool}${ti.description ? `: ${ti.description}` : ''}`, answerable: true,
        details: { command, cwd: input.cwd, title: tool },
        options: [
          { key: 'once', label: '1. Yes', send: 'hook: allow (this call only)' },
          ...(suggestions.length ? [{ key: 'always', label: `2. Yes, and always allow ${suggestions.map(describeSuggestion).join('; ')}`, send: 'hook: allow and add the rule', risk: 'wide-access' as Risk }] : []),
          { key: 'no', label: `${suggestions.length ? 3 : 2}. No`, send: 'hook: deny with your message', deny: true },
        ],
        text: { mode: 'deny', placeholder: 'Optional: tell the agent why, or what to do instead. Sent with "No".', send: 'with "No"' } };
    }
    let done = false;
    const finish = (out: unknown) => { if (done) return; done = true; clearTimeout(timer); resolve(out); };
    const l = add(t, base, actions, textAction, finish);
    const timer = setTimeout(() => { if (live.has(l.item.id)) close(l, 'gone', 'Taskboard stopped waiting for the hook. The dialog stays in the terminal.'); finish(undefined); }, maxMs);
    closed(() => { if (live.has(l.item.id) && l.item.state === 'pending') close(l, 'gone', 'The agent closed this question: it was answered in the terminal, or the hook timed out.'); finish(undefined); });
  });
}

// ---------- screen prompts and end-of-turn questions ----------
const hasHook = (taskId: string) => [...live.values()].some(l => l.item.taskId === taskId && l.item.source === 'claude-hook' && l.item.state !== 'gone');
const openFor = (taskId: string, source?: PendingSource) => [...live.values()].filter(l => l.item.taskId === taskId && (!source || l.item.source === source));
export const hasOpen = (taskId: string) => openFor(taskId).length > 0;

function screenItem(t: Task, p: ScreenPrompt) {
  const actions = new Map<string, Action>();
  const options: PendingOption[] = p.options.map((o, i) => {
    actions.set(`o${i}`, { via: 'keys', index: i });
    const send = o.key ? `keys: ${o.key}` : i === p.selected ? 'keys: Enter (this row is selected)' : `keys: ${i > p.selected ? '↓' : '↑'} ×${Math.abs(i - Math.max(p.selected, 0))}, then Enter`;
    return { key: `o${i}`, label: o.label, send, ...(o.risk ? { risk: o.risk } : {}), ...(i === p.selected ? { selected: true } : {}) };
  });
  const kind: PendingKind = p.kind === 'command' ? 'command' : p.kind === 'plan' ? 'plan' : p.kind === 'signin' ? 'signin' : p.kind === 'unknown' ? 'unknown' : 'dialog';
  add(t, { kind, source: 'screen', name: p.name, question: p.question, options: p.answerable ? options : [], answerable: p.answerable,
    details: Object.keys(p.details).length ? p.details : undefined, screen: { hash: p.hash, excerpt: p.excerpt } }, actions);
}

const TURN_END = /Stop hook|agent-turn-complete|Antigravity Stop hook/;
// Called by the watcher (index.ts reconcile) with the visible screen of a task that waits on the user, or that has an
// open item. It adds, keeps or closes the items of this task.
export function scan(t: Task, screen: string) {
  const waiting = t.status === 'needs-you';
  if (waiting && hasHook(t.id)) return; // the hook item describes the dialog; the hook ending closes it
  const p = waiting ? parsePrompt(t.agent, screen.split('\n').slice(-45).join('\n')) : null;
  for (const l of openFor(t.id, 'screen')) {
    if (l.item.state !== 'pending') continue;
    if (p && p.hash === l.item.screen?.hash) { if (l.item.screen.excerpt !== p.excerpt) { l.item.screen.excerpt = p.excerpt; emit(); } continue; }
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
  const set = hidden.get(l.item.taskId) || new Set<string>(); set.add(l.item.screen!.hash); hidden.set(l.item.taskId, set);
  close(l, 'gone', 'Hidden by the user: not a question.');
}
// a task that was archived, removed or moved: its items close
export function forgetTask(taskId: string) { for (const l of openFor(taskId)) close(l, 'gone', 'The task was closed.'); }

// ---------- list ----------
export function list(): PendingItem[] {
  const open = [...live.values()];
  for (const l of open) {
    const same = open.filter(o => o !== l && o.item.state === 'pending' && o.signature === l.signature && o.item.answerable);
    l.item.sameIn = same.length && l.item.answerable ? same.map(o => ({ id: o.item.id, taskId: o.item.taskId, taskNum: o.item.taskNum })) : undefined;
  }
  return open.map(l => l.item).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export const answeredList = () => history.slice(0, 40);
export const get = (id: string) => live.get(id)?.item || history.find(h => h.id === id);

// ---------- answers ----------
export interface AnswerInput { option?: string; text?: string; confirm?: boolean; group?: string[]; by: 'user' | 'controller'; rule?: string }
export class AnswerError extends Error { constructor(message: string, public status = 409) { super(message); } }

async function typeKeys(t: Task, l: Live, index: number, expect?: string): Promise<string> {
  await io.cancelCopyMode(t.session);
  const read = async () => parsePrompt(t.agent, (await io.capture(t.session)).split('\n').slice(-45).join('\n'));
  const p = await read();
  if (!p || (expect ? p.name !== expect : p.hash !== l.item.screen?.hash))
    throw new AnswerError('The prompt on the screen is not the one on this card any more. Taskboard typed nothing.');
  if (!p.answerable || !p.options[index]) throw new AnswerError('Taskboard cannot answer this prompt. Taskboard typed nothing.');
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
    if (!now || now.hash !== p.hash) throw new AnswerError(`The prompt changed after ${moves.join('')}. Enter was not pressed. Check the terminal.`);
    sel = now.selected;
  }
  const check = await read();
  if (!check || check.hash !== p.hash || check.selected !== index) throw new AnswerError(`The highlight is not on "${opt.label}". Enter was not pressed. Check the terminal.`);
  await io.key(t.session, 'Enter', false);
  return after(`keys: ${[...moves, 'Enter'].join(' ')}`);
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
  if (action.via === 'keys') return typeKeys(t, l, action.index, action.expect);
  const r = await io.sendText(t, text);
  if (!r.submitted) throw new AnswerError(r.warning || 'The text was typed, but Enter was not pressed. Check the terminal.');
  return `prompt: "${text.length > 80 ? text.slice(0, 77) + '…' : text}" + Enter`;
}

export async function answer(id: string, input: AnswerInput): Promise<PendingItem> {
  const l = live.get(id);
  if (!l) { const h = history.find(x => x.id === id); throw new AnswerError(h ? `This card is closed: ${h.result || h.state}.` : 'This card does not exist.', h ? 409 : 404); }
  if (l.item.state !== 'pending') throw new AnswerError('This card is being answered now.');
  if (!l.item.answerable) throw new AnswerError('Taskboard cannot answer this prompt. Open the terminal.', 400);
  const opt = input.option ? l.item.options.find(o => o.key === input.option) : undefined;
  if (input.option && input.option !== 'form' && !opt) throw new AnswerError('This answer does not exist for this card.', 400);
  if (opt?.risk && !input.confirm) throw new AnswerError('This option needs the confirm step.', 400);
  const group = (input.group || []).filter(x => x !== id);
  const allowed = new Set((list().find(i => i.id === id)?.sameIn || []).map(s => s.id));
  if (group.some(g => !allowed.has(g))) throw new AnswerError('A task in the group no longer waits on the same prompt. Nothing was sent.');
  const targets = [l, ...group.map(g => live.get(g)!)];
  const label = opt?.label || (input.option === 'form' ? 'the form answers' : 'your text');
  const nums = targets.map(x => x.item.taskNum);
  const errors: string[] = [];
  for (const x of targets) {
    if (x.item.state !== 'pending') { errors.push(`#${x.item.taskNum}: already answered.`); continue; }
    x.item.state = 'sending'; emit();
    try {
      const sent = await sendOne(x, input);
      x.item.answer = { by: input.by, label, sent, at: new Date().toISOString(), rule: input.rule, ...(nums.length > 1 ? { tasks: nums } : {}) };
      const t = io.getTask(x.item.taskId);
      if (t) {
        const who = input.by === 'user' ? 'The user' : `The controller (${input.rule})`;
        io.log(t, `${who} answered "${x.item.question.slice(0, 160)}" with "${label}" on the Waiting page${nums.length > 1 ? ` (one answer for ${nums.map(n => '#' + n).join(', ')})` : ''}. Taskboard sent ${sent}.`);
        if (x.item.source !== 'turn-end') io.answered(t, `Answered on the Waiting page at ${clock()}.`);
      }
      close(x, 'answered', `Sent ${sent}.`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push(`#${x.item.taskNum}: ${message}`);
      x.item.state = 'pending'; x.item.result = message; emit();
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
