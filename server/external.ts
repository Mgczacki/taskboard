// Sessions running in a terminal Taskboard does not own send no hooks, so their state is read from the end of
// their transcript file: Claude Code's ~/.claude/projects/…/<session>.jsonl, Codex's rollout-….jsonl, or Antigravity's
// ~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript_full.jsonl.
import { closeSync, openSync, readSync, statSync } from 'node:fs';

export interface TranscriptState {
  // 'finished': the agent ended its turn · 'tool': a tool call has no result yet (running, or waiting for approval)
  // 'busy': the last record is a prompt or a tool result, so the agent is thinking · 'aborted': the turn was interrupted
  state: 'finished' | 'tool' | 'busy' | 'aborted' | 'unknown';
  text?: string;   // last message from the agent
  tool?: string;   // the pending tool call, e.g. "Bash: npm test"
  toolAt?: number; // when that call was made
  waitMs?: number; // the call's own timeout, for Codex calls that wait on purpose (duration_ms)
  mtime: number;   // when the transcript file last changed (also by bookkeeping records, e.g. Remote Control)
  at?: number;     // time of the conversation record the state was read from
}

function tailLines(path: string, bytes = 262144): string[] {
  const size = statSync(path).size, start = Math.max(0, size - bytes), buf = Buffer.alloc(size - start);
  const fd = openSync(path, 'r'); try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
  const lines = buf.toString('utf8').split('\n');
  if (start > 0) lines.shift(); // first line is cut
  return lines.filter(Boolean);
}
const parse = (l: string) => { try { return JSON.parse(l); } catch { return null; } };
const short = (s: string, n = 140) => s.replace(/\s+/g, ' ').trim().slice(0, n);

function claude(lines: string[]): Omit<TranscriptState, 'mtime'> {
  let text: string | undefined;
  // walk backwards over the conversation records; attachments, system notes and bookkeeping records are skipped
  for (let i = lines.length - 1; i >= 0; i--) {
    const o = parse(lines[i]); if (!o || (o.type !== 'user' && o.type !== 'assistant')) continue;
    // records Claude Code adds itself (background-task notifications, meta notes) are not a prompt from anyone
    if (o.type === 'user' && (o.isMeta || (typeof o.message?.content === 'string' && /^\s*<(task-notification|local-command|command-name|system-reminder)/.test(o.message.content)))) continue;
    const c = o.message?.content;
    const parts: any[] = Array.isArray(c) ? c : [{ type: 'text', text: String(c ?? '') }];
    if (o.type === 'assistant') {
      const tu = parts.find(p => p.type === 'tool_use');
      if (tu) return { state: 'tool', toolAt: Date.parse(o.timestamp) || undefined, tool: `${tu.name}${tu.input?.command ? ': ' + short(String(tu.input.command), 80) : tu.input?.file_path ? ': ' + tu.input.file_path : ''}` };
      const tx = parts.filter(p => p.type === 'text').map(p => p.text).join('\n');
      if (tx) text = text ?? short(tx, 400);
      if (o.message?.stop_reason === 'end_turn' || tx) return { state: 'finished', text };
      continue; // thinking-only record: keep looking
    }
    if (parts.some(p => p.type === 'text' && /\[Request interrupted by user/.test(p.text || ''))) return { state: 'aborted' };
    return { state: 'busy' };
  }
  return { state: 'unknown' };
}

function codex(lines: string[]): Omit<TranscriptState, 'mtime'> {
  let text: string | undefined, pendingCall: string | undefined, callAt: number | undefined, waitMs: number | undefined;
  const outputs = new Set<string>();
  for (let i = lines.length - 1; i >= 0; i--) {
    const o = parse(lines[i]); const p = o?.payload; if (!p) continue;
    if (o.type === 'event_msg') {
      if (p.type === 'task_complete') return { state: 'finished', text: text ?? (p.last_agent_message ? short(p.last_agent_message, 400) : undefined) };
      if (p.type === 'turn_aborted') return { state: 'aborted' };
      if (p.type === 'agent_message' && !text && p.message) text = short(p.message, 400);
      if (p.type === 'task_started' || p.type === 'user_message') return pendingCall ? { state: 'tool', tool: pendingCall, toolAt: callAt, waitMs } : { state: 'busy' };
    }
    if (o.type === 'response_item') {
      if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') outputs.add(p.call_id);
      if ((p.type === 'custom_tool_call' || p.type === 'function_call') && !pendingCall && !outputs.has(p.call_id)) {
        let cmd = ''; try { const a = typeof p.input === 'string' ? p.input : JSON.parse(p.arguments || '{}').cmd ?? p.arguments; cmd = Array.isArray(a) ? a.join(' ') : String(a ?? ''); } catch { cmd = String(p.arguments ?? ''); }
        pendingCall = `${p.name}${cmd ? ': ' + short(cmd, 80) : ''}`; callAt = Date.parse(o.timestamp) || undefined;
        try { const d = JSON.parse(p.arguments || '{}').duration_ms ?? JSON.parse(p.arguments || '{}').timeout_ms; if (typeof d === 'number') waitMs = d; } catch { /* not JSON */ }
      }
    }
  }
  // no turn start within the part read: a long turn still in progress, as long as there were model or tool records
  return pendingCall ? { state: 'tool', tool: pendingCall, toolAt: callAt, waitMs } : outputs.size || text ? { state: 'busy', text } : { state: 'unknown' };
}

// Antigravity: one record per step, { step_index, type, status, created_at, content, tool_calls }. USER_INPUT is a
// prompt, PLANNER_RESPONSE is a model step (a reply in content, or tool_calls), GENERIC is a tool result.
function antigravity(lines: string[]): Omit<TranscriptState, 'mtime'> {
  let hadResult = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const o = parse(lines[i]); if (!o || typeof o.type !== 'string') continue;
    if (o.type === 'GENERIC') { hadResult = true; continue; }
    if (o.type === 'USER_INPUT') return { state: 'busy' };
    if (o.type !== 'PLANNER_RESPONSE') continue;
    const tc = Array.isArray(o.tool_calls) ? o.tool_calls[0] : undefined;
    if (tc) {
      if (hadResult) return { state: 'busy' };
      const cmd = tc.args?.CommandLine;
      return { state: 'tool', toolAt: Date.parse(o.created_at) || undefined, tool: `${tc.name}${cmd ? ': ' + short(String(cmd), 80) : ''}` };
    }
    if (typeof o.content === 'string' && o.content.trim()) return { state: 'finished', text: short(o.content, 400) };
    // a step with thinking only: keep looking
  }
  return { state: 'unknown' };
}

export function readState(agent: 'claude' | 'codex' | 'antigravity', path: string): TranscriptState | null {
  try {
    const mtime = statSync(path).mtimeMs, lines = tailLines(path);
    // time of the newest conversation record, for comparisons that bookkeeping writes must not affect
    let at: number | undefined;
    for (let i = lines.length - 1; i >= 0 && at === undefined; i--) {
      const o = parse(lines[i]); if (!o) continue;
      if ((o.type === 'user' || o.type === 'assistant' || o.type === 'response_item' || o.type === 'event_msg') && o.timestamp) at = Date.parse(o.timestamp);
      else if (agent === 'antigravity' && o.created_at) at = Date.parse(o.created_at);
    }
    return { ...(agent === 'claude' ? claude(lines) : agent === 'codex' ? codex(lines) : antigravity(lines)), mtime, at };
  } catch { return null; }
}

// The question titles of the newest request_user_input_async call in a Codex rollout file. Codex records the call and
// an immediate {"accepted":true} result, but not the answers, so this cannot tell whether the questions are still open.
export function codexQuestions(path: string): string[] {
  try {
    const lines = tailLines(path);
    for (let i = lines.length - 1; i >= 0; i--) {
      const p = parse(lines[i])?.payload;
      if (p?.type === 'function_call' && p.name === 'request_user_input_async')
        return (JSON.parse(p.arguments || '{}').questions || []).map((q: any) => short(String(q.title || ''), 200)).filter(Boolean);
    }
  } catch { /* moved or not JSON */ }
  return [];
}
