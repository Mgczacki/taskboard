// Ask panel on a canvas tile: questions about the task, answered by a separate read-only agent (server/ask.ts).
// The task's own agent gets no input. The panel polls the thread while an answer is on its way.
import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { AskThread, Task } from '../api';
import { api } from '../api';

const md = (s: string) => DOMPurify.sanitize(marked.parse(s, { async: false }) as string);
const secs = (ms?: number) => ms === undefined ? '' : `${(ms / 1000).toFixed(1)} s`;

export function AskPanel({ task, close }: { task: Task; close: () => void }) {
  const [thread, setThread] = useState<AskThread>({ items: [] });
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const busy = thread.items.some(i => i.state === 'running');

  useEffect(() => { api.askThread(task.id).then(setThread).catch(e => setErr(String(e.message || e))); }, [task.id]);
  useEffect(() => {
    if (!busy) return;
    const iv = setInterval(() => api.askThread(task.id).then(setThread).catch(() => {}), 800);
    return () => clearInterval(iv);
  }, [busy, task.id]);
  const count = thread.items.length, last = thread.items[count - 1];
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [count, last?.state, last?.steps.length]);

  const send = async () => {
    const text = q.trim(); if (!text || busy) return;
    setErr(''); setQ('');
    try { setThread(await api.ask(task.id, text)); } catch (e) { setErr(String((e as Error).message || e)); setQ(text); }
  };

  return (
    <div className="ask" onMouseDown={e => e.stopPropagation()}>
      <div className="ask-h">
        <b>Ask about #{task.num}</b>
        <span className="sub">A separate agent reads the terminal and the transcript. #{task.num} does not see the question.</span>
        <span className="sp" />
        {count > 0 && !busy && <button className="btn" title="Start a new thread (the next question starts a new conversation)" onClick={() => api.askClear(task.id).then(setThread)}>New thread</button>}
        <button className="btn ghost icon" title="Close (the thread is kept)" aria-label="Close Ask panel" onClick={close}>✕</button>
      </div>
      <div className="ask-list" ref={list}>
        {!count && <div className="ask-empty">For example: “What has it done so far?”, “Why is it waiting?”, “Which files did it change?”</div>}
        {thread.items.map((i, n) => (
          <div key={n} className="ask-item">
            <div className="ask-q">{i.q}</div>
            {i.steps.length > 0 && <div className="ask-steps">{i.steps.map((s, k) => <div key={k}>{s}</div>)}</div>}
            {i.state === 'running' ? <div className="ask-wait">Working… <button className="btn" onClick={() => api.askStop(task.id)}>Stop</button></div>
              : <div className={`ask-a md ${i.state}`} dangerouslySetInnerHTML={{ __html: md(i.a || '') }} />}
            {i.state !== 'running' && <div className="ask-meta">{[i.costUsd !== undefined ? `$${i.costUsd.toFixed(3)}` : '', secs(i.ms), i.agent === 'codex' ? 'Codex' : 'Claude Code', i.model, i.account].filter(Boolean).join(' · ')}</div>}
          </div>
        ))}
      </div>
      {err && <div className="ask-err">{err}</div>}
      <div className="ask-in field">
        <textarea value={q} autoFocus rows={2} aria-label="Question about this session" placeholder={busy ? 'Wait for the answer…' : count ? 'Ask a follow-up question (Enter sends, Shift+Enter adds a line)' : 'Ask a question about this session (Enter sends)'}
          onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } if (e.key === 'Escape') close(); }} />
        <button className="btn primary" disabled={busy || !q.trim()} onClick={send}>Ask</button>
      </div>
    </div>
  );
}
