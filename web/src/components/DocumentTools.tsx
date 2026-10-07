// Comment and BTW for one document, in the floating viewer (Docs.tsx) and the full-size document window
// (DocumentWindow.tsx). The controls belong to the Taskboard page. An HTML document stays in its sandboxed iframe
// beside them and cannot reach them or Taskboard's API.
// The server finds the owning task from the file path (server/document-context.ts). A file that no task on this
// machine owns gets no controls.
// - Comment: the text goes to the owning task, through the review item of the file when it has one.
//   Accept is a separate button and sends no text.
// - BTW: a separate read-only agent answers. The owning task's agent does not get the question.
// The unsent comment and the unsent question are saved (documentDraft.ts), so another view of the same document shows them.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AskThread, DocumentContext } from '../api';
import { api } from '../api';
import { draftKey, moveDraft, useDraft } from '../documentDraft';
import { AskItems } from './Ask';

type Panel = 'comment' | 'btw';
const short = (path: string) => path.replace(/^\/Users\/[^/]+/, '~');
const when = (iso: string) => new Date(iso).toLocaleString('sv-SE').slice(0, 16);
const agentName = (a: string) => a === 'claude' ? 'Claude Code' : a === 'codex' ? 'Codex' : 'Antigravity';

export function DocumentTools({ path, children }: { path: string; children: ReactNode }) {
  const [ctx, setCtx] = useState<DocumentContext | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  // a file that no task owns gives the error 'This file is not a document…'; another failure keeps the controls
  const load = useCallback(() => { if (path) api.documentContext(path).then(setCtx).catch(e => { if (/not a document/.test(String((e as Error).message))) setCtx(null); }); }, [path]);
  useEffect(() => { setCtx(null); load(); }, [load]);
  // a new review version or an accepted review shows while a panel is open
  useEffect(() => { if (!panel) return; const iv = setInterval(load, 10_000); return () => clearInterval(iv); }, [panel, load]);
  const version = ctx?.review?.version;
  const last = useRef<{ path: string; version?: number } | null>(null);
  useEffect(() => {
    if (!ctx) return;
    const before = last.current;
    if (before && before.path === ctx.path && before.version && version && before.version !== version)
      for (const kind of ['comment', 'btw'] as const) moveDraft(draftKey(kind, ctx.path, before.version), draftKey(kind, ctx.path, version));
    last.current = { path: ctx.path, version };
  }, [ctx?.path, version]);
  const [comment] = useDraft('comment', ctx?.path, version);

  const toggle = (p: Panel) => setPanel(now => now === p ? null : p);
  // The document keeps its place in the tree before and after the owner is known. A new place would draw the
  // document again: the floating viewer would lose its content, and an HTML document would load again.
  return (
    <div className="dt">
      {ctx && <div className="dt-bar" onMouseDown={e => e.stopPropagation()}>
        <span className="dt-owner" title={`${ctx.path}\nTask #${ctx.task.num} ${ctx.task.title}`}>
          <b>#{ctx.task.num}</b> {ctx.task.title}{ctx.box ? ` · ${ctx.box}` : ''} · {ctx.review ? `review version ${ctx.review.version}` : 'not a review item'}
        </span>
        <span className="sp" />
        <button className={`btn ${panel === 'comment' ? 'on' : ''}`} aria-pressed={panel === 'comment'} onClick={() => toggle('comment')} title={`Write a comment about this document for task #${ctx.task.num}`}>Comment{comment.trim() ? ' (draft)' : ''}</button>
        <button className={`btn ${panel === 'btw' ? 'on' : ''}`} aria-pressed={panel === 'btw'} onClick={() => toggle('btw')} title={`BTW: ask a separate read-only agent about this document. Task #${ctx.task.num} does not see the question.`}>BTW</button>
      </div>}
      <div className="dt-row">
        <div className="dt-doc">{children}</div>
        {ctx && panel && <aside className="dt-side" onMouseDown={e => e.stopPropagation()}>
          {panel === 'comment' ? <CommentPanel ctx={ctx} reload={load} close={() => setPanel(null)} /> : <BtwPanel ctx={ctx} close={() => setPanel(null)} />}
        </aside>}
      </div>
    </div>
  );
}

function Facts({ ctx }: { ctx: DocumentContext }) {
  return (
    <dl className="dt-facts">
      <dt>Task</dt><dd>#{ctx.task.num} {ctx.task.title}</dd>
      <dt>File</dt><dd><code title={ctx.path}>{short(ctx.path)}</code></dd>
      <dt>Version</dt><dd>{ctx.review ? `Version ${ctx.review.version} of the review item, requested at ${when(ctx.at)}` : `Not a review item, so it has no version. Last changed at ${when(ctx.at)}.`}</dd>
    </dl>
  );
}

function CommentPanel({ ctx, reload, close }: { ctx: DocumentContext; reload: () => void; close: () => void }) {
  const version = ctx.review?.version;
  const [text, setText] = useDraft('comment', ctx.path, version);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const body = text.trim(); if (!body || busy) return;
    setBusy(true); setMsg(`Sending to task #${ctx.task.num}…`);
    try {
      const r = await api.documentComment(ctx.path, body, version);
      setText('');
      const what = r.comments > 1 ? `${r.comments} comments (with the unsent comments from the Inbox page)` : 'The comment';
      setMsg(r.delivery === 'queued' ? `${what} for #${r.taskNum}: saved in its inbox, but not typed yet. ${r.reason || ''} Taskboard types the notice when the agent's input box is empty.`
        : `${what} went to #${r.taskNum}${r.version ? ` for version ${r.version}` : ''}.${r.resumed ? ' The task resumed.' : ''}`);
    } catch (e) { setMsg((e as Error).message); }
    setBusy(false); reload();
  };
  const accept = async () => {
    if (!ctx.review || busy) return;
    setBusy(true);
    try { await api.documentAcceptReview(ctx.review.id); setMsg(`Version ${ctx.review.version} accepted. No comment was sent.`); } catch (e) { setMsg((e as Error).message); }
    setBusy(false); reload();
  };
  return (
    <>
      <div className="dt-h"><b>Comment on this document</b><span className="sp" /><button className="btn ghost icon" title="Close (the draft is kept)" aria-label="Close comment panel" onClick={close}>✕</button></div>
      <div className="dt-body">
        <Facts ctx={ctx} />
        {ctx.review?.state === 'changes' && <div className="banner">You sent comments on version {ctx.review.version}. The agent revises the document. A new comment goes to the same version.</div>}
        {ctx.review?.state === 'accepted' && <div className="banner">You accepted version {ctx.review.version}. A comment opens the review again.</div>}
        <textarea className="dt-text" autoFocus value={text} aria-label={`Comment for task #${ctx.task.num} about ${ctx.name}`} placeholder={`Your comment about ${ctx.name} for task #${ctx.task.num}`}
          onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); void send(); } if (e.key === 'Escape') e.stopPropagation(); }} />
        <div className="dt-sub">{ctx.review ? `The comment goes to #${ctx.task.num} as review comments on version ${ctx.review.version}. Unsent comments from the Inbox page for this version go with it.` : `The comment goes to the inbox of #${ctx.task.num}, and Taskboard tells its agent.`} The draft is saved until you send it.</div>
        <div className="dt-actions">
          {ctx.review?.state === 'pending' && <button className="btn" disabled={busy || !!text.trim()} onClick={accept} title={text.trim() ? 'Send or delete the draft comment first. Accept sends no comment.' : `Accept version ${ctx.review.version} without a comment`}>Accept version {ctx.review.version}</button>}
          <span className="sp" />
          <button className="btn primary" disabled={busy || !text.trim()} onClick={send}>{busy ? 'Sending…' : `Send comment to #${ctx.task.num}`} <kbd>⌘↩</kbd></button>
        </div>
        {msg && <div className="banner" role="status">{msg}</div>}
      </div>
    </>
  );
}

function BtwPanel({ ctx, close }: { ctx: DocumentContext; close: () => void }) {
  const version = ctx.review?.version;
  const [thread, setThread] = useState<AskThread>({ items: [] });
  const [q, setQ] = useDraft('btw', ctx.path, version);
  const [model, setModel] = useState(ctx.btw.model);
  const [err, setErr] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const busy = thread.items.some(i => i.state === 'running');
  useEffect(() => { setThread({ items: [] }); api.documentAskThread(ctx.path).then(setThread).catch(e => setErr(String(e.message || e))); }, [ctx.path, version]);
  useEffect(() => {
    if (!busy) return;
    const iv = setInterval(() => api.documentAskThread(ctx.path).then(setThread).catch(() => {}), 800);
    return () => clearInterval(iv);
  }, [busy, ctx.path]);
  useEffect(() => { setModel(ctx.btw.model); }, [ctx.btw.model]);
  const count = thread.items.length, last = thread.items[count - 1];
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [count, last?.state, last?.steps.length]);
  const send = async () => {
    const text = q.trim(); if (!text || busy || !model.trim()) return;
    setErr(''); setQ('');
    try { setThread(await api.documentAsk(ctx.path, text, model.trim())); } catch (e) { setErr(String((e as Error).message || e)); setQ(text); }
  };
  const b = ctx.btw, taskModel = b.taskModel || 'not known';
  return (
    <>
      <div className="dt-h"><b>BTW about this document</b><span className="sp" />
        {count > 0 && !busy && <button className="btn" title="Start a new thread (the next question starts a new conversation)" onClick={() => api.documentAskClear(ctx.path).then(setThread)}>New thread</button>}
        <button className="btn ghost icon" title="Close (the thread is kept)" aria-label="Close BTW panel" onClick={close}>✕</button></div>
      <div className="dt-sub dt-pad">A separate read-only agent answers. #{ctx.task.num} does not see the question. The agent reads a copy of {ctx.review ? `version ${ctx.review.version} of this document` : 'this document'} and the transcript of #{ctx.task.num} up to {when(ctx.at)}.</div>
      <div className="dt-model dt-pad">
        {b.matches
          ? <div className="banner">The BTW model in Settings ({b.configured}) is the model of #{ctx.task.num} ({taskModel}). Choose the model for this question:{' '}
            {b.options.length ? <select value={model} aria-label="BTW model for this document" onChange={e => setModel(e.target.value)}>{b.options.map(m => <option key={m} value={m}>{m}</option>)}<option value={b.configured}>{b.configured} (same as the task)</option></select>
              : <input value={model} aria-label="BTW model for this document" placeholder={`A ${agentName(b.agent)} model`} onChange={e => setModel(e.target.value)} />}</div>
          : <div className="dt-sub">Answers: {agentName(b.agent)} {b.configured} ({b.account}). Model of #{ctx.task.num}: {agentName(b.taskAgent)} {taskModel}.</div>}
      </div>
      <div className="ask-list" ref={list}>
        {!count && <div className="ask-empty">For example: “Why does the document choose this option?”, “Which files did the agent read before it wrote this?”, “Is the summary complete?”</div>}
        <AskItems thread={thread} stop={() => api.documentAskStop(ctx.path)} />
      </div>
      {err && <div className="ask-err">{err}</div>}
      <div className="ask-in field">
        <textarea value={q} autoFocus rows={2} aria-label="BTW side question about this document" placeholder={busy ? 'Wait for the answer…' : count ? 'Ask a follow-up question (Enter sends, Shift+Enter adds a line)' : 'Ask a side question about this document (Enter sends)'}
          onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } if (e.key === 'Escape') e.stopPropagation(); }} />
        <button className="btn primary" disabled={busy || !q.trim() || !model.trim()} onClick={send}>Send</button>
      </div>
    </>
  );
}
