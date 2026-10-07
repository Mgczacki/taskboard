// Questions about a task, answered by a separate Claude Code or Codex process that can only read files.
// The task's own agent gets no input, so its context does not change. The separate agent gets the task's log and
// terminal tail in its prompt and reads the task's transcript only when those do not answer the question.
// Follow-up questions resume the separate agent's own conversation, never the task's.
// The thread is saved in ~/AgentVault/tasks/<id>/ask.json; the dashboard polls GET /api/tasks/:id/ask while it runs.
// A question about one document (server/document-context.ts) uses the same process, settings and limits through run().
// Its thread has its own key and file, and its agent gets no folder of the task.
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
  agent?: 'claude' | 'codex'; // older saved items have no agent and were answered by Claude Code
  model: string;
  account: string;
  at: string;
}
export interface AskThread { sessionId?: string; accountId?: string; agent?: 'claude' | 'codex'; model?: string; items: AskItem[] }

const file = (id: string) => join(store.taskDir(id), 'ask.json');
// by thread key: a task id, or the key of a document thread (it starts with DOC_KEY)
const running = new Map<string, ChildProcess>();
export const DOC_KEY = 'doc-';

// The thread with this key, saved in this file.
export function read(key: string, path: string): AskThread {
  let t: AskThread = { items: [] };
  try { if (existsSync(path)) t = JSON.parse(readFileSync(path, 'utf8')); } catch { /* unreadable: start a new thread */ }
  // a question that was running when Taskboard stopped has no process any more
  if (!running.has(key)) for (const i of t.items) if (i.state === 'running') { i.state = 'failed'; i.a = i.a || 'Taskboard restarted before the answer came back.'; }
  return t;
}
export const get = (id: string) => read(id, file(id));
const write = (path: string, t: AskThread) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(t, null, 2)); };

export const runningTasks = () => [...running.keys()].filter(k => !k.startsWith(DOC_KEY));
export const runningDocuments = () => [...running.keys()].filter(k => k.startsWith(DOC_KEY)).length;
export const isRunning = (key: string) => running.has(key);
export function clear(id: string) { stop(id); write(file(id), { items: [] }); return get(id); }
export function stop(key: string) { const p = running.get(key); if (p) p.kill('SIGTERM'); }

// The transcript path: recorded by the hooks (Claude) or by the task watcher (Codex); else searched in the account folder.
export function transcriptOf(t: Task): string | undefined {
  if (t.transcript && existsSync(t.transcript)) return t.transcript;
  if (!t.sessionId) return;
  const acct = accounts.get(t.account) || accounts.defaultFor(t.agent);
  return importer.transcriptFor(t.agent, t.sessionId, acct.dir);
}

const RULES = `You answer the user's questions about another coding agent's session in Taskboard. You are not that agent.
You cannot change the session. Read files only. Do not run commands that write files or change other systems.
- Answer from the log and the terminal tail in the message first.
- If they do not answer the question, read the session's transcript. It is a JSONL file, often several MB.
  Do not read it from the start. Search for a word from the question, or read near the end and work backwards.
  Read 20 to 40 lines at a time. One line can hold a whole file or tool output.
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
  const tr = transcriptOf(t);
  return run({
    key: t.id, file: file(t.id), cwd: join(ASK_DIR, t.id), rules: RULES, dirs: [t.cwd, ...(tr ? [dirname(tr)] : [])],
    busy: 'A question about this task is still running. Wait for it, or stop it.',
    prompt: async first => message(t, await tmux.capture(t.session, TAIL_LINES), question, first),
  }, question);
}

// What one thread is about. prompt(first) builds the message of a question; first is true when the separate agent
// starts a new conversation. dirs are the folders the agent may read besides cwd. onlyCwd: the agent's permission
// mode is set to "default", so a setting of the account that allows every read does not apply.
export interface Subject {
  key: string; file: string; cwd: string; rules: string; dirs: string[]; busy: string;
  prompt: (first: boolean) => string | Promise<string>;
  model?: string; onlyCwd?: boolean; done?: () => void;
}
// The arguments of the separate Claude Code process: three read tools, no MCP servers, a cost limit.
export function claudeArgs(prompt: string, model: string, s: Pick<Subject, 'rules' | 'dirs' | 'onlyCwd'>, sessionId?: string): string[] {
  return ['-p', prompt, '--model', model, '--tools', 'Read,Grep,Glob',
    '--append-system-prompt', s.rules, '--strict-mcp-config', '--output-format', 'stream-json', '--verbose', '--max-budget-usd', MAX_BUDGET_USD,
    ...(s.onlyCwd ? ['--permission-mode', 'default'] : []),
    ...s.dirs.flatMap(d => ['--add-dir', d]), ...(sessionId ? ['--resume', sessionId] : [])];
}

export async function run(subject: Subject, question: string): Promise<AskThread> {
  const key = subject.key, rules = subject.rules;
  const save = (t: AskThread) => write(subject.file, t);
  if (running.has(key)) throw new Error(subject.busy);
  const settings = machine.get().ask;
  const agent = settings.agent;
  const model = subject.model || settings.model;
  const acct = accounts.get(settings.account) || accounts.defaultFor(agent);
  if (acct.agent !== agent) throw new Error('The BTW account does not match its agent. Change it in Settings.');
  const thread = read(key, subject.file);
  // a conversation lives in one account's folder and uses one model
  if (thread.accountId !== acct.id || thread.agent !== agent || thread.model !== model) {
    thread.sessionId = undefined; thread.accountId = acct.id; thread.agent = agent; thread.model = model;
  }
  const cwd = subject.cwd; mkdirSync(cwd, { recursive: true });
  const prompt = await subject.prompt(!thread.sessionId);
  if (running.has(key)) throw new Error(subject.busy);
  const claude = claudeArgs(prompt, model, subject, thread.sessionId);
  // Codex loads no user configuration, plugins, or ChatGPT apps. Its read-only sandbox applies to every turn.
  const codexLimits = ['--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--json', '-c', 'mcp_servers={}',
    '--disable', 'apps', '--disable', 'plugins', '--disable', 'remote_plugin',
    '--disable', 'skill_mcp_dependency_install', '--disable', 'tool_call_mcp_elicitation',
    '--disable', 'mcp_2026_07_28', '--disable', 'codex_apps_mcp_2026_07_28', '--disable', 'enable_mcp_apps'];
  const codexArgs = thread.sessionId
    ? ['exec', 'resume', ...codexLimits, '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"', '-m', model, thread.sessionId, `${rules}\n\n${prompt}`]
    : ['exec', ...codexLimits, '--sandbox', 'read-only', '-c', 'approval_policy="never"', '-m', model, `${rules}\n\n${prompt}`];
  // the task's own variables are left out, so `tb` or a hook cannot act as the task
  const env: Record<string, string | undefined> = { ...process.env, ...accounts.envFor(acct) };
  for (const k of ['TASK_ID', 'TASK_DIR', 'TASK_NUM', 'TB_URL', 'TB_TOKEN_FILE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) delete env[k];
  if (acct.isDefault) delete env.CLAUDE_CONFIG_DIR;
  if (acct.isDefault) delete env.CODEX_HOME;
  const item: AskItem = { q: question, state: 'running', steps: [], agent, model, account: acct.name, at: new Date().toISOString() };
  thread.items.push(item); save(thread);
  const started = Date.now();
  const bin = agent === 'claude' ? 'claude' : 'codex';
  const p = spawn(bin, agent === 'claude' ? claude : codexArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  running.set(key, p);
  let buf = '', err = '', result: { text?: string; cost?: number; isError?: boolean } = {};
  p.stdout!.on('data', d => {
    buf += d; if (buf.length > 2_000_000) buf = buf.slice(-2_000_000);
    const lines = buf.split('\n'); buf = lines.pop()!;
    for (const l of lines) {
      let m: any; try { m = JSON.parse(l); } catch { continue; }
      if (agent === 'claude') {
        if (m.session_id && !thread.sessionId) thread.sessionId = m.session_id;
        if (m.type === 'assistant') {
          if (m.message?.model) item.model = m.message.model;
          for (const c of m.message?.content || []) if (c.type === 'tool_use') { item.steps.push(step(c.name, c.input || {})); item.steps = item.steps.slice(-200); save(thread); }
        }
        if (m.type === 'result') result = { text: m.result, cost: m.total_cost_usd, isError: m.is_error };
      } else {
        if (m.type === 'thread.started' && m.thread_id) thread.sessionId = m.thread_id;
        if (m.type === 'item.started' && m.item?.type === 'command_execution') {
          item.steps.push(String(m.item.command || 'Read files').slice(0, 160)); item.steps = item.steps.slice(-200); save(thread);
        }
        if (m.type === 'item.completed' && m.item?.type === 'agent_message') result.text = m.item.text;
        if (m.type === 'turn.failed') { result.isError = true; result.text = m.error?.message; }
      }
    }
  });
  p.stderr!.on('data', d => { err = (err + d).slice(-16_384); });
  p.on('close', (code, signal) => {
    running.delete(key);
    item.ms = Date.now() - started; item.costUsd = result.cost;
    if (signal) { item.state = 'stopped'; item.a = 'Stopped.'; }
    else if (code === 0 && result.text && !result.isError) { item.state = 'done'; item.a = result.text; }
    else { item.state = 'failed'; item.a = result.text || err.trim().split('\n').slice(-3).join('\n') || `${bin} exited with code ${code}.`; }
    save(thread);
    subject.done?.();
  });
  p.on('error', e => { running.delete(key); item.state = 'failed'; item.a = `Could not start ${bin}: ${e.message}`; save(thread); subject.done?.(); });
  return thread;
}
