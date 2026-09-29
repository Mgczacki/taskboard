// User inbox: documents and diagrams agents asked you to review (with `tb review <file>`).
// Comment on paragraphs or diagrams, send the comments back to the agent, compare versions, accept.
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '../api';
import { fmtWait } from '../api';
import { fileUrl } from './Docs';
import { AgentChip, Kbd } from './ui';
import { hit, useKeymap } from '../keys';
import { api } from '../api';
import { loadAccounts, type Account } from './Accounts';
import '../review.css';
import type { DocumentLink } from '../documentLinks';
import { decorateDocument } from '../documentContent';

interface Comment { id: string; v: number; block: number; quote: string; text: string; at: string; sent?: boolean }
interface Item {
  id: string; path: string; name: string; task: string; state: 'pending' | 'changes' | 'accepted'; version: number;
  versions: { v: number; at: string }[]; comments: Comment[]; requestedAt: string; updated: string; dismissedAt?: string;
  taskNum?: number; taskTitle?: string; agent?: Task['agent']; taskStatus?: string;
}
interface Block { raw: string; html: string; mermaid?: string }

const ago = (iso: string) => fmtWait(Math.round((Date.now() - Date.parse(iso)) / 60000));
const isHtml = (n: string) => /\.html?$/i.test(n);
async function send(method: string, path: string, body?: unknown) {
  const r = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || r.statusText);
  return d;
}

// Split Markdown into top-level blocks so comments can be anchored to one paragraph, list or diagram.
function toBlocks(md: string): Block[] {
  return marked.lexer(md).filter(t => t.type !== 'space').map(t => {
    if (t.type === 'code' && (t as { lang?: string }).lang === 'mermaid') return { raw: t.raw, html: '', mermaid: (t as { text: string }).text };
    return { raw: t.raw, html: DOMPurify.sanitize(marked.parser([t] as never)) };
  });
}
// Block-level diff (longest common subsequence on trimmed block text).
function diff(a: Block[], b: Block[]): { block: Block; kind: 'same' | 'add' | 'del' }[] {
  const A = a.map(x => x.raw.trim()), B = b.map(x => x.raw.trim());
  const dp = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { block: Block; kind: 'same' | 'add' | 'del' }[] = []; let i = 0, j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) { out.push({ block: b[j], kind: 'same' }); i++; j++; }
    else if (j < B.length && (i >= A.length || dp[i][j + 1] >= dp[i + 1][j])) { out.push({ block: b[j], kind: 'add' }); j++; }
    else { out.push({ block: a[i], kind: 'del' }); i++; }
  }
  return out;
}

let mermaidLoad: Promise<typeof import('mermaid').default> | null = null;
function getMermaid() {
  if (!mermaidLoad) mermaidLoad = import('mermaid').then(m => {
    const css = (n: string, f: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f;
    // labels as SVG text: HTML labels live in <foreignObject>, which the sanitizer removes
    m.default.initialize({ startOnLoad: false, theme: 'base', securityLevel: 'strict', htmlLabels: false, flowchart: { htmlLabels: false }, themeVariables: {
      background: css('--bg2', '#121519'), primaryColor: css('--panel2', '#1d2127'), primaryTextColor: css('--text', '#e4e7ec'),
      primaryBorderColor: css('--line2', '#333a44'), lineColor: css('--muted', '#9aa3af'), textColor: css('--text', '#e4e7ec'), fontSize: '14px',
    } });
    return m.default;
  });
  return mermaidLoad;
}
function Mermaid({ code, onClick, hasComments }: { code: string; onClick: () => void; hasComments: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    getMermaid().then(m => m.render('mm' + Math.random().toString(36).slice(2), code)).then(({ svg }) => { if (alive && ref.current) ref.current.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } }); }).catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, [code]);
  if (failed) return <pre className="rv-code">{code}</pre>;
  return <div className={`rv-diagram ${hasComments ? 'has' : ''}`} ref={ref} onClick={onClick} title="Click to comment on this diagram" />;
}

export function InboxPage({ tasks, open, documentLink }: { tasks: Task[]; open: (id: string, tab?: 'terminal' | 'log' | 'docs') => void; documentLink?: DocumentLink | null }) {
  const [dismissed, setDismissed] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  useKeymap();
  const [sel, setSel] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [prevText, setPrevText] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  const [draft, setDraft] = useState<{ block: number; quote: string } | null>(null);
  const [draftText, setDraftText] = useState('');
  const [general, setGeneral] = useState('');
  const [selBtn, setSelBtn] = useState<{ x: number; y: number; block: number; quote: string } | null>(null);
  const [msg, setMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [moveTo, setMoveTo] = useState('');
  const docRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (documentLink?.reviewId) { setDismissed(false); setSel(documentLink.reviewId); } }, [documentLink]);

  const load = useCallback(() => fetch(`/api/review${dismissed ? '?dismissed=1' : ''}`).then(r => r.json()).then((x: Item[]) => { setItems(x); setSel(s => s && x.some(i => i.id === s) ? s : documentLink?.reviewId && x.some(i => i.id === documentLink.reviewId) ? documentLink.reviewId : x[0]?.id || null); }).catch(() => setItems([])), [dismissed, documentLink?.reviewId]);
  useEffect(() => { load(); const iv = setInterval(load, 5000); return () => clearInterval(iv); }, [load]);
  useEffect(() => { load(); }, [tasks, load]);

  const item = items?.find(i => i.id === sel);
  useEffect(() => {
    setText(null); setPrevText(null); setCompare(false); setDraft(null);
    if (!item) return;
    fetch(`/api/review/${item.id}/v/${item.version}`).then(r => r.ok ? r.text() : fetch(fileUrl(item.path)).then(x => x.text())).then(setText);
    if (item.version > 1) fetch(`/api/review/${item.id}/v/${item.version - 1}`).then(r => r.ok ? r.text() : null).then(setPrevText);
  }, [item?.id, item?.version]);

  const blocks = useMemo(() => (text && item && !isHtml(item.name) ? toBlocks(text) : []), [text, item?.name]);
  useEffect(() => {
    if (!item || item.id !== documentLink?.reviewId || !text || !docRef.current) return;
    const target = documentLink.heading
      ? [...docRef.current.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')].find(h => h.textContent?.trim().toLowerCase().replace(/\s+/g, '-') === documentLink.heading?.toLowerCase())
      : documentLink.line ? [...docRef.current.querySelectorAll<HTMLElement>('.rv-block')].find((b, index) => blocks.slice(0, index + 1).reduce((n, x) => n + x.raw.split('\n').length - 1, 0) >= documentLink.line!) : null;
    requestAnimationFrame(() => target?.scrollIntoView({ block: 'start' }));
  }, [documentLink, item?.id, text, blocks]);
  const shown = useMemo(() => compare && prevText ? diff(toBlocks(prevText), blocks) : blocks.map(b => ({ block: b, kind: 'same' as const })), [compare, prevText, blocks]);
  useEffect(() => {
    const root = docRef.current?.querySelector<HTMLElement>('.rv-md');
    if (!root || !item) return;
    return decorateDocument(root, item.path);
  }, [shown, item?.path]);
  const current = item ? item.comments.filter(c => c.v === item.version) : [];
  const unsent = current.filter(c => !c.sent);
  const task = item && tasks.find(t => t.id === item.task);

  const act = async (p: Promise<unknown>, ok?: string) => { try { await p; if (ok) setMsg(ok); load(); } catch (e) { setMsg((e as Error).message); } };
  const addComment = async (block: number, quote: string, t: string) => { if (!item || !t.trim()) return; await act(send('POST', `/api/review/${item.id}/comment`, { block, quote, text: t.trim() })); };
  const sendFeedback = async () => {
    if (!item || item.dismissedAt || sending) return;
    setSending(true); setMsg('Resuming or contacting the agent…'); setMoveOpen(false);
    try {
      const result = await send('POST', `/api/review/${item.id}/feedback`) as { resumed: boolean };
      setMsg(result.resumed ? 'Sent. The task resumed.' : 'Sent. The agent received the comments.');
      load();
    } catch (e) {
      const error = (e as Error).message;
      setMsg(error);
      if (/usage or parallel task limit/.test(error)) {
        setMoveOpen(true);
        loadAccounts().then(setAccounts).catch(() => setAccounts([]));
      }
    } finally { setSending(false); }
  };
  const accept = () => item && !item.dismissedAt && act(send('POST', `/api/review/${item.id}/accept`), 'Accepted.');

  // select text in a block → "Comment" button next to it
  const onMouseUp = () => {
    const s = window.getSelection(); if (!s || s.isCollapsed || !docRef.current) { setSelBtn(null); return; }
    const node = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode as HTMLElement : s.anchorNode.parentElement);
    const b = node?.closest('[data-block]') as HTMLElement | null; if (!b) { setSelBtn(null); return; }
    const r = s.getRangeAt(0).getBoundingClientRect(), d = docRef.current.getBoundingClientRect();
    setSelBtn({ x: r.right - d.left + docRef.current.scrollLeft, y: r.top - d.top + docRef.current.scrollTop - 6, block: Number(b.dataset.block), quote: s.toString().trim() });
  };
  const startDraft = (block: number, quote: string) => { setDraft({ block, quote }); setDraftText(''); setSelBtn(null); window.getSelection()?.removeAllRanges(); };

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      // keys.ts: hit() leaves out keys typed into a text field or a terminal
      if (hit(e, 'reviewSend')) { e.preventDefault(); sendFeedback(); return; }
      if (!items?.length) return;
      const i = items.findIndex(x => x.id === sel);
      if (hit(e, 'reviewNext')) setSel(items[Math.min(items.length - 1, i + 1)].id);
      else if (hit(e, 'reviewPrev')) setSel(items[Math.max(0, i - 1)].id);
      else if (hit(e, 'reviewComment') && selBtn) { e.preventDefault(); startDraft(selBtn.block, selBtn.quote); }
      else if (hit(e, 'reviewAccept') && item && !item.dismissedAt && item.state !== 'accepted') accept();
    };
    addEventListener('keydown', on); return () => removeEventListener('keydown', on);
  });

  const switchView = () => { setItems(null); setSel(null); setDismissed(x => !x); };
  const viewButton = <button className="btn" onClick={switchView}>{dismissed ? 'Back to inbox' : 'Dismissed'}</button>;

  if (!items) return <div className="emptyview">Loading…</div>;
  if (!items.length) return (
    <div className="emptyview"><h2>{dismissed ? 'No dismissed items' : 'Your inbox is empty'}</h2>{viewButton}
      <p>Your agents send documents here for review with <code>tb review &lt;file&gt;</code>. You can comment on a document and send feedback to its agent. New versions appear in the same inbox item.</p></div>
  );

  const groups: [string, Item[]][] = dismissed ? [['Dismissed', items]] : [
    ['Needs your review', items.filter(i => i.state === 'pending')],
    ['Agent revising', items.filter(i => i.state === 'changes')],
    ['Accepted', items.filter(i => i.state === 'accepted')],
  ];
  const commentsFor = (b: number) => current.filter(c => c.block === b);

  return (
    <div className="rv">
      <aside className="rv-queue">
        {viewButton}
        {groups.map(([label, list]) => list.length > 0 && <div key={label}>
          <div className="rv-qh">{label} · {list.length}</div>
          {list.map(i => (
            <div key={i.id} className={`rv-qi ${i.id === sel ? 'on' : ''}`} onClick={() => setSel(i.id)}>
              <div className="rv-qt">{i.name}</div>
              <button className="btn ghost" onClick={e => { e.stopPropagation(); act(send('POST', `/api/review/${i.id}/${dismissed ? 'restore' : 'dismiss'}`)); }}>{dismissed ? 'Restore' : 'Dismiss'}</button>
              <div className="rv-qs"><span>#{i.taskNum ?? '?'}</span><span className="chip">v{i.version}</span>{i.state === 'pending' && <span className="rv-wait">waiting {ago(i.requestedAt)}</span>}{i.state !== 'pending' && <span>{ago(i.updated)} ago</span>}</div>
            </div>
          ))}
        </div>)}
        <div className="rv-keys"><Kbd id="reviewNext" />/<Kbd id="reviewPrev" /> next/previous · <Kbd id="reviewComment" /> comment on selection · <Kbd id="reviewAccept" /> accept · <Kbd id="reviewSend" /> send</div>
      </aside>

      {item && <section className="rv-main">
        <header className="rv-head">
          <div className="rv-title"><h2>{item.name}</h2><span className="chip">version {item.version}</span>{item.agent && <AgentChip a={item.agent} />}</div>
          <div className="rv-sub">From #{item.taskNum} {item.taskTitle} · <code>{item.path.replace(/^\/Users\/[^/]+/, '~')}</code></div>
          <div className="rv-actions">
            <button className="btn" onClick={() => open(item.task, 'terminal')} disabled={!task}>Open agent terminal</button>
            <a className="btn" href={fileUrl(item.path)} target="_blank" rel="noreferrer">Open file ↗</a>
            {item.version > 1 && !isHtml(item.name) && <button className={`btn ${compare ? 'on' : ''}`} onClick={() => setCompare(c => !c)}>{compare ? `Show v${item.version} only` : `Compare v${item.version - 1} → v${item.version}`}</button>}
            <span style={{ flex: 1 }} />
            {item.dismissedAt ? <button className="btn" onClick={() => act(send('POST', `/api/review/${item.id}/restore`))}>Restore to inbox</button> : item.state === 'accepted'
              ? <button className="btn" onClick={() => act(send('POST', `/api/review/${item.id}/reopen`))}>Reopen</button>
              : <><button className="btn" onClick={accept}>Accept <Kbd id="reviewAccept" /></button>
                <button className="btn primary" disabled={!unsent.length || sending} onClick={sendFeedback}>{sending ? 'Resuming…' : `Send feedback to #${item.taskNum}`} {unsent.length > 0 && `(${unsent.length})`} <Kbd id="reviewSend" /></button></>}
          </div>
          {item.state === 'changes' && <div className="banner">You sent comments on version {item.version}. The agent is revising; the next version appears here when it runs <code>tb review</code> again.</div>}
          {item.state === 'accepted' && <div className="banner">Accepted.</div>}
          {msg && <div className="banner">{msg} <button className="btn ghost" onClick={() => setMsg('')}>OK</button></div>}
          {moveOpen && task && <div className="banner">
            <label htmlFor="review-move-account">Move task to another account</label>
            <select id="review-move-account" value={moveTo} onChange={e => setMoveTo(e.target.value)}>
              <option value="">Choose an account</option>
              {accounts.filter(a => a.id !== (task.account || `${task.agent}-default`)).map(a => <option key={a.id} value={a.id} disabled={!a.status.signedIn || !!a.limited || a.running >= a.maxParallel}>{a.name} ({a.agent})</option>)}
            </select>
            <button className="btn" disabled={!moveTo || sending} onClick={async () => {
              setSending(true); setMsg('Moving the task…');
              try { await api.moveAccount(task.id, moveTo); setMoveOpen(false); setMsg('The task moved. Send feedback again.'); load(); }
              catch (e) { setMsg((e as Error).message); }
              finally { setSending(false); }
            }}>Move task</button>
          </div>}
        </header>

        <div className="rv-body">
          <div className="rv-doc" ref={docRef} onMouseUp={onMouseUp}>
            {text === null && <div className="empty">Loading the document…</div>}
            {text !== null && isHtml(item.name) && <iframe className="rv-frame" sandbox="allow-scripts allow-popups" src={fileUrl(item.path)} title={item.name} />}
            {text !== null && !isHtml(item.name) && <div className="md doc rv-md">
              {shown.map((s, i) => {
                const idx = blocks.indexOf(s.block); const cs = idx >= 0 ? commentsFor(idx) : [];
                return (
                  <div key={i} data-block={idx} className={`rv-block ${s.kind} ${cs.length ? 'has' : ''} ${draft?.block === idx ? 'drafting' : ''}`}>
                    {s.block.mermaid ? <Mermaid code={s.block.mermaid} hasComments={cs.length > 0} onClick={() => idx >= 0 && startDraft(idx, 'the diagram')} /> : <div dangerouslySetInnerHTML={{ __html: s.block.html }} />}
                    {s.kind === 'same' && idx >= 0 && <button className="rv-plus" title="Comment on this block" onClick={() => startDraft(idx, s.block.raw.replace(/\s+/g, ' ').trim().slice(0, 160))}>＋</button>}
                  </div>
                );
              })}
            </div>}
            {selBtn && <button className="btn primary rv-selbtn" style={{ left: selBtn.x, top: selBtn.y }} onMouseDown={e => { e.preventDefault(); startDraft(selBtn.block, selBtn.quote); }}>Comment <Kbd id="reviewComment" /></button>}
          </div>

          <aside className="rv-comments">
            {item.dismissedAt && <div className="banner">Dismissed without acceptance or feedback. Restore this item to continue its review.</div>}
            <fieldset disabled={!!item.dismissedAt} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            {draft && <div className="rv-c draft">
              <div className="rv-q">“{draft.quote.slice(0, 160)}”</div>
              <textarea autoFocus value={draftText} onChange={e => setDraftText(e.target.value)} placeholder="Your comment" onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); addComment(draft.block, draft.quote, draftText).then(() => setDraft(null)); } if (e.key === 'Escape') setDraft(null); }} />
              <div className="rv-row"><button className="btn ghost" onClick={() => setDraft(null)}>Cancel</button><button className="btn primary" onClick={() => addComment(draft.block, draft.quote, draftText).then(() => setDraft(null))}>Save <kbd>⌘↩</kbd></button></div>
            </div>}
            {current.filter(c => c.block >= 0).sort((a, b) => a.block - b.block).map(c => <CommentCard key={c.id} c={c} item={item} reload={load} onJump={() => docRef.current?.querySelector(`[data-block="${c.block}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })} />)}
            <div className="rv-general">
              <div className="rv-qh">General comment</div>
              {current.filter(c => c.block < 0).map(c => <CommentCard key={c.id} c={c} item={item} reload={load} />)}
              <textarea value={general} onChange={e => setGeneral(e.target.value)} placeholder={isHtml(item.name) ? 'Comments on this page' : 'A comment about the whole document'} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); addComment(-1, '', general).then(() => setGeneral('')); } }} />
              <div className="rv-row"><button className="btn" disabled={!general.trim()} onClick={() => addComment(-1, '', general).then(() => setGeneral(''))}>Add</button></div>
            </div>
            {!current.length && !draft && <div className="rv-hint">Select text and press <Kbd id="reviewComment" />, hover a paragraph and click ＋, or click a diagram to comment on it. Comments stay here until you press <b>Send feedback</b>.</div>}
            </fieldset>
          </aside>
        </div>
      </section>}
    </div>
  );
}

function CommentCard({ c, item, reload, onJump }: { c: Comment; item: Item; reload: () => void; onJump?: () => void }) {
  const [edit, setEdit] = useState(false);
  const [t, setT] = useState(c.text);
  const save = async () => { await send('PATCH', `/api/review/${item.id}/comment/${c.id}`, { text: t }); setEdit(false); reload(); };
  return (
    <div className={`rv-c ${c.sent ? 'sent' : ''}`}>
      {c.quote && <div className="rv-q" onClick={onJump}>“{c.quote.slice(0, 160)}”</div>}
      {edit ? <><textarea value={t} onChange={e => setT(e.target.value)} autoFocus /><div className="rv-row"><button className="btn ghost" onClick={() => setEdit(false)}>Cancel</button><button className="btn primary" onClick={save}>Save</button></div></>
        : <div className="rv-t">{c.text}</div>}
      {!edit && <div className="rv-cm">{c.sent ? 'sent' : 'not sent yet'}{!c.sent && <> · <button className="btn ghost" onClick={() => setEdit(true)}>edit</button> · <button className="btn ghost" onClick={async () => { await send('DELETE', `/api/review/${item.id}/comment/${c.id}`); reload(); }}>delete</button></>}</div>}
    </div>
  );
}
