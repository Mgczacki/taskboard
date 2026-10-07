import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as store from './store.ts';
import type { Agent, Task } from './store.ts';

export interface AnswerRecord {
  id: string; taskId: string; question: string; askedAt: string; answeredAt: string;
  answer: string; transcript: string; sessionId?: string; questionOffset: number; answerOffset: number;
}
interface Question { id: string; text: string; at: string; transcript?: string; sessionId?: string; offset: number }
interface Data { questions: Question[]; answers: AnswerRecord[]; cursors: Record<string, number> }
const empty = (): Data => ({ questions: [], answers: [], cursors: {} });
const file = (id: string) => join(store.taskDir(id), 'answer-history.json');
const read = (id: string): Data => {
  if (!existsSync(file(id))) return empty();
  try { const data = JSON.parse(readFileSync(file(id), 'utf8')); return { ...empty(), ...data }; } catch { return empty(); }
};
const save = (id: string, data: Data) => writeFileSync(file(id), JSON.stringify(data, null, 2));
const size = (path?: string) => { try { return path ? statSync(path).size : 0; } catch { return 0; } };
export const answers = (id: string): AnswerRecord[] => read(id).answers;
export function isQuestion(text: string) { return /\?/.test(text) && text.trim().length <= 12000; }
export function prepare(t: Task, text: string) {
  const id = randomUUID().replace(/-/g, '').slice(0, 12);
  const data = read(t.id);
  data.questions.push({ id, text, at: new Date().toISOString(), transcript: t.transcript, sessionId: t.sessionId, offset: size(t.transcript) });
  save(t.id, data);
  return { id, text: `${text}\n\n[Taskboard question ${id}. If you answer this question, put one final line in your final reply: TASKBOARD_ANSWER ${id}: <one short sentence>. Do not use this line for an unanswered question.]` };
}
export function cancel(id: string, questionId: string) {
  const data = read(id); data.questions = data.questions.filter(q => q.id !== questionId); save(id, data);
}
// Only a complete, last line of an agent reply can create an entry. Quoted text and code blocks have other last lines.
export function parseAnswer(message: string): { id: string; answer: string } | null {
  const lines = message.trimEnd().split('\n');
  let fenced = false;
  for (const line of lines.slice(0, -1)) if (/^\s*```/.test(line)) fenced = !fenced;
  if (fenced) return null;
  const match = /^TASKBOARD_ANSWER ([a-f0-9]{12}): ([^\r\n]{1,240})$/.exec(lines.at(-1) || '');
  if (!match || !match[2].trim() || /[<>]/.test(match[2])) return null;
  return { id: match[1], answer: match[2].trim() };
}
function finalText(agent: Agent, o: any): string | null {
  if (agent === 'codex') return o.type === 'event_msg' && o.payload?.type === 'task_complete' ? String(o.payload.last_agent_message || '') : null;
  if (agent === 'claude') {
    if (o.type !== 'assistant' || o.isSidechain || o.message?.stop_reason !== 'end_turn') return null;
    const content = o.message?.content;
    return Array.isArray(content) ? content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n') : typeof content === 'string' ? content : null;
  }
  if (o.type !== 'PLANNER_RESPONSE' || (Array.isArray(o.tool_calls) && o.tool_calls.length)) return null;
  return typeof o.content === 'string' ? o.content : null;
}
function userText(agent: Agent, o: any): string {
  if (agent === 'codex' && o.type === 'response_item' && o.payload?.type === 'message' && o.payload?.role === 'user')
    return (o.payload.content || []).map((c: any) => c.text || '').join('\n');
  if (agent === 'codex' && o.type === 'event_msg' && o.payload?.type === 'user_message') return String(o.payload.message || '');
  if (agent === 'claude' && o.type === 'user' && !o.isMeta) {
    const content = o.message?.content;
    return Array.isArray(content) ? content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n') : typeof content === 'string' ? content : '';
  }
  return agent === 'antigravity' && o.type === 'USER_INPUT' ? String(o.content || '') : '';
}
export function scan(t: Task): number {
  if (!t.transcript || !existsSync(t.transcript) || !existsSync(file(t.id))) return 0;
  const data = read(t.id), path = t.transcript, key = `${t.sessionId || ''}:${path}`;
  if (!data.questions.length) return 0;
  const end = size(path), old = data.cursors[key] || 0, start = old > end ? 0 : old;
  if (start === end) return 0;
  let pos = start, added = 0;
  const processLine = (line: Buffer, offset: number) => {
    const part = line.toString('utf8');
    let o: any; try { o = JSON.parse(part); } catch { return; }
    const input = userText(t.agent, o);
    for (const q of data.questions) if (input.includes(`Taskboard question ${q.id}`)) { q.transcript = path; q.offset = offset; }
    const message = finalText(t.agent, o); if (!message) return;
    const parsed = parseAnswer(message); if (!parsed || data.answers.some(a => a.id === parsed.id)) return;
    const q = data.questions.find(q => q.id === parsed.id);
    if (!q || (q.sessionId && t.sessionId && q.sessionId !== t.sessionId) || offset < q.offset) return;
    data.answers.push({ id: q.id, taskId: t.id, question: q.text, askedAt: q.at, answeredAt: o.timestamp || o.created_at || new Date().toISOString(), answer: parsed.answer, transcript: path, sessionId: t.sessionId, questionOffset: q.offset, answerOffset: offset });
    added++;
  };
  const fd = openSync(path, 'r'), chunk = Buffer.alloc(1024 * 1024);
  let carry = Buffer.alloc(0), readAt = start;
  try {
    while (readAt < end) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, end - readAt), readAt);
      if (!n) break;
      readAt += n;
      const block = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      let from = 0, newline: number;
      while ((newline = block.indexOf(10, from)) >= 0) {
        processLine(block.subarray(from, newline), pos);
        pos += newline - from + 1;
        from = newline + 1;
      }
      carry = Buffer.from(block.subarray(from));
    }
  } finally { closeSync(fd); }
  data.cursors[key] = pos; save(t.id, data);
  if (added) store.touch(t.id);
  return added;
}
export function transcriptRecord(id: string, answerId: string, at: 'question' | 'answer') {
  const answer = answers(id).find(a => a.id === answerId);
  if (!answer) return null;
  const offset = at === 'question' ? answer.questionOffset : answer.answerOffset;
  if (!existsSync(answer.transcript)) return { available: false, text: '' };
  const fd = openSync(answer.transcript, 'r'), buf = Buffer.alloc(256 * 1024);
  try {
    const n = readSync(fd, buf, 0, buf.length, offset);
    const line = buf.subarray(0, n).toString('utf8').split('\n')[0];
    const o = JSON.parse(line), agent = store.get(id)?.agent || 'codex';
    if (at === 'question') {
      const input = userText(agent, o);
      return input.includes(`Taskboard question ${answerId}`) ? { available: true, text: input } : { available: false, text: answer.question };
    }
    return { available: true, text: finalText(agent, o) || answer.answer };
  } catch { return { available: false, text: answer.answer }; }
  finally { closeSync(fd); }
}
