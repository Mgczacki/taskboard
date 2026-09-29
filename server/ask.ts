// Questions about a task, answered by a separate Claude Code process (`claude -p`) that can only read files.
// The task's own agent gets no input, so its context does not change. The separate agent gets the task's log and
// terminal tail in its prompt and reads the task's transcript only when those do not answer the question.
// Follow-up questions resume the separate agent's own conversation (`--resume`), never the task's.
// The thread is saved in ~/AgentVault/tasks/<id>/ask.json; the dashboard polls GET /api/tasks/:id/ask while it runs.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TB_DIR } from './config.ts';
import * as accounts from './accounts.ts';
import * as importer from './importer.ts';
import * as machine from './machine.ts';
import * as store from './store.ts';
import type { Task } from './store.ts';
import * as tmux from './tmux.ts';

// the separate agent's working folder; importer.candidates() leaves sessions in it off the Import page
export const ASK_DIR = join(TB_DIR, 'ask');
const TAIL_LINES = 200;
const MAX_BUDGET_USD = '0.50';

export interface AskItem {
  q: string;
  a?: string;
  state: 'running' | 'done' | 'failed' | 'stopped';
  steps: string[];      // tool calls of the separate agent, for example "Read …/abc.jsonl (from line 4000)"
  costUsd?: number;     // total_cost_usd from claude's result
  ms?: number;
  model: string;
  account: string;
  at: string;
}
export interface AskThread { sessionId?: string; accountId?: string; items: AskItem[] }

const file = (id: string) => join(store.taskDir(id), 'ask.json');
const running = new Map<string, ChildProcess>();

export function get(id: string): AskThread {
  let t: AskThread = { items: [] };
  try { if (existsSync(file(id))) t = JSON.parse(readFileSync(file(id), 'utf8')); } catch { /* unreadable: start a new thread */ }
  // a question that was running when Taskboard stopped has no process any more
  if (!running.has(id)) for (const i of t.items) if (i.state === 'running') { i.state = 'failed'; i.a = i.a || 'Taskboard restarted before the answer came back.'; }
  return t;
}
const save = (id: string, t: AskThread) => writeFileSync(file(id), JSON.stringify(t, null, 2));

export function clear(id: string) { stop(id); save(id, { items: [] }); return get(id); }
export function stop(id: string) { const p = running.get(id); if (p) p.kill('SIGTERM'); }

// The transcript path: recorded by the hooks (Claude) or by the task watcher (Codex); else searched in the account folder.
function transcriptOf(t: Task): string | undefined {
  if (t.transcript && existsSync(t.transcript)) return t.transcript;
  if (!t.sessionId) return;
  const acct = accounts.get(t.account) || accounts.defaultFor(t.agent);
  return importer.transcriptFor(t.agent, t.sessionId, acct.dir);
}

const RULES = `You answer the user's questions about another coding agent's session in Taskboard. You are not that agent.
You cannot change the session, and you must not try: you only have tools that read files.
- Answer from the log and the terminal tail in the message first.
- If they do not answer the question, read the session's transcript. It is a JSONL file, often several MB.
  Do not read it from the start: use Grep for a word from the question, or Read with an offset near the end, and work backwards.
  Always give Read a limit of 20 to 40 lines: one line can hold a whole file or tool output, and each line you read costs the user.
  Grep with output_mode "content" and a short -C context usually finds the answer faster than Read.
- Claude Code transcripts have one record per line with "type" user / assistant and message.content (text, tool_use, tool_result).
- Codex rollout files have one record per line with "type" response_item / event_msg and a "payload".
- You may also read files in the session's working folder when the question is about the code.
- Say where each fact comes from (terminal, log, transcript, or a file) and say when you are not sure.
- Answer in plain English, in short sentences. Put three or more items in a bulleted list.`;

function message(t: Task, tail: string, question: string, first: boolean) {
  const log = store.readLog(t.id).split(/\n(?=## )/).slice(-3).join('\n').trim();
  const tr = transcriptOf(t);
  return [
    first ? `The session is task #${t.num} "${t.title}" (${t.agent === 'claude' ? 'Claude Code' : t.agent === 'codex' ? 'Codex' : 'Antigravity'}), working folder ${t.cwd}.` : 'The session has moved on since the last question. Here is its current state.',
    first ? `Its goal: ${t.goal || t.title}` : '',
    `Status now: ${t.status}${t.ask ? ` (waiting for: ${t.ask})` : ''}.`,
    `Transcript: ${tr ? `${tr} (${t.agent === 'claude' ? 'Claude Code JSONL' : t.agent === 'codex' ? 'Codex rollout JSONL' : 'Antigravity transcript_full.jsonl, one record per step'})` : 'not found'}.`,
    first && log ? `\n<log>\n${log}\n</log>` : '',
    `\n<terminal-tail lines="${TAIL_LINES}">\n${tail.trimEnd() || '(the session is not running, so there is no terminal)'}\n</terminal-tail>`,
    `\nQuestion: ${question}`,
  ].filter(Boolean).join('\n');
}

// one line for each tool call, shown while the answer is on its way
function step(name: string, input: Record<string, unknown>): string {
  const short = (p: unknown) => String(p || '').replace(/^.*\/(?=[^/]+\/[^/]+$)/, '…/');
  if (name === 'Read') return `Read ${short(input.file_path)}${input.offset ? ` (from line ${input.offset})` : ''}`;
  if (name === 'Grep') return `Search for "${String(input.pattern).slice(0, 60)}"${input.path ? ` in ${short(input.path)}` : ''}`;
  if (name === 'Glob') return `List ${String(input.pattern).slice(0, 60)}`;
  return name;
}

export async function ask(t: Task, question: string): Promise<AskThread> {
  if (running.has(t.id)) throw new Error('A question about this task is still running. Wait for it, or stop it.');
  const settings = machine.get().ask;
  const acct = accounts.get(settings.account) || accounts.defaultFor('claude');
  if (acct.agent !== 'claude') throw new Error('The account for questions must be a Claude Code account. Change it in Settings.');
  const thread = get(t.id);
  // a conversation lives in one account's folder: after a change of account in Settings, the next question starts a new one
  if (thread.accountId !== acct.id) { thread.sessionId = undefined; thread.accountId = acct.id; }
  const tail = await tmux.capture(t.session, TAIL_LINES);
  const tr = transcriptOf(t);
  const cwd = join(ASK_DIR, t.id); mkdirSync(cwd, { recursive: true });
  const args = ['-p', message(t, tail, question, !thread.sessionId), '--model', settings.model, '--tools', 'Read,Grep,Glob',
    '--append-system-prompt', RULES, '--strict-mcp-config', '--output-format', 'stream-json', '--verbose', '--max-budget-usd', MAX_BUDGET_USD,
    '--add-dir', t.cwd, ...(tr ? ['--add-dir', dirname(tr)] : []), ...(thread.sessionId ? ['--resume', thread.sessionId] : [])];
  // the task's own variables are left out, so `tb` or a hook cannot act as the task
  const env: Record<string, string | undefined> = { ...process.env, ...accounts.envFor(acct) };
  for (const k of ['TASK_ID', 'TASK_DIR', 'TASK_NUM', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) delete env[k];
  if (acct.isDefault) delete env.CLAUDE_CONFIG_DIR;
  const item: AskItem = { q: question, state: 'running', steps: [], model: settings.model, account: acct.name, at: new Date().toISOString() };
  thread.items.push(item); save(t.id, thread);
  const started = Date.now();
  const p = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  running.set(t.id, p);
  let buf = '', err = '', result: { text?: string; cost?: number; isError?: boolean } = {};
  p.stdout!.on('data', d => {
    buf += d; const lines = buf.split('\n'); buf = lines.pop()!;
    for (const l of lines) {
      let m: any; try { m = JSON.parse(l); } catch { continue; }
      if (m.session_id && !thread.sessionId) thread.sessionId = m.session_id;
      if (m.type === 'assistant') for (const c of m.message?.content || []) if (c.type === 'tool_use') { item.steps.push(step(c.name, c.input || {})); save(t.id, thread); }
      if (m.type === 'result') result = { text: m.result, cost: m.total_cost_usd, isError: m.is_error };
    }
  });
  p.stderr!.on('data', d => { err += d; });
  p.on('close', (code, signal) => {
    running.delete(t.id);
    item.ms = Date.now() - started; item.costUsd = result.cost;
    if (signal) { item.state = 'stopped'; item.a = 'Stopped.'; }
    else if (result.text && !result.isError) { item.state = 'done'; item.a = result.text; }
    else { item.state = 'failed'; item.a = result.text || err.trim().split('\n').slice(-3).join('\n') || `claude exited with code ${code}.`; }
    save(t.id, thread);
  });
  p.on('error', e => { running.delete(t.id); item.state = 'failed'; item.a = `Could not start claude: ${e.message}`; save(t.id, thread); });
  return thread;
}
