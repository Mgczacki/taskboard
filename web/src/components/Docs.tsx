// Inbox / outbox tab, Markdown reader and floating HTML previews.
// Agent-written files are shown safely: Markdown is sanitized; HTML runs in a sandboxed iframe served with a
// sandbox Content-Security-Policy, so it cannot reach Taskboard's API.
import DOMPurify from 'dompurify';
import { uploadAll } from '../drop';
import { marked } from 'marked';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Task } from '../api';
import { api, fmtWait } from '../api';
import type { DocumentLink } from '../documentLinks';
import { decorateDocument } from '../documentContent';

export interface DocInfo { name: string; path: string; kind: 'md' | 'html' | 'other'; size: number; mtime: string; from?: { task: string; num: number; title: string; at: string }; sentTo?: { task: string; num: number; at: string }[] }
// files of tasks on another machine are fetched through this server (?machine=)
let currentMachine = '';
// A local file's path goes in the URL path (/api/files/…), so relative links in an HTML page find the files next to it.
export const fileUrl = (path: string, machine = currentMachine) => machine || !path.startsWith('/')
  ? `/api/file?path=${encodeURIComponent(path)}${machine ? '&machine=' + encodeURIComponent(machine) : ''}`
  : '/api/files' + path.split('/').map(encodeURIComponent).join('/');
const ago = (iso: string) => fmtWait(Math.round((Date.now() - Date.parse(iso)) / 60000)) + ' ago';
const kb = (n: number) => n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`;

export function openDoc(d: { path: string; name: string; kind: string }, location?: { line?: number; heading?: string }) {
  if (d.kind === 'html') previewHtml(d.path, d.name, location?.heading);
  else if (d.kind === 'md') readMarkdown(d.path, d.name, location);
  else window.open(fileUrl(d.path), '_blank');
}
export const openInBrowser = (path: string) => window.open(fileUrl(path), '_blank');

export function DocsTab({ t, tasks, documentLink }: { t: Task; tasks: Task[]; documentLink?: DocumentLink | null }) {
  const [d, setD] = useState<{ inbox: DocInfo[]; outbox: DocInfo[] } | null>(null);
  const [msg, setMsg] = useState('');
  currentMachine = t.machine?.id || '';
  const load = () => fetch(`/api/tasks/${encodeURIComponent(t.id)}/docs`).then(r => r.json()).then(setD);
  useEffect(() => { load(); }, [t.id, t.updated, (t as Task & { docs?: { inbox: number; outbox: number } }).docs?.outbox, (t as Task & { docs?: { inbox: number } }).docs?.inbox]);
  const opened = useRef<DocumentLink | null>(null);
  useEffect(() => {
    if (!d || !documentLink || opened.current === documentLink) return;
    const file = [...d.inbox, ...d.outbox].find(x => x.path === documentLink.path);
    if (file) { opened.current = documentLink; openDoc(file, documentLink); }
  }, [d, documentLink]);
  if (!d) return <div className="empty">Loading…</div>;
  const others = tasks.filter(x => x.id !== t.id && x.status !== 'archived');

  const row = (x: DocInfo, box: 'inbox' | 'outbox') => (
    <div key={x.path} className="lk" tabIndex={0} onKeyDown={e => { if (e.target !== e.currentTarget) return; if (e.key === ' ') { e.preventDefault(); openDoc(x); } if (e.key === 'Enter') { e.preventDefault(); openInBrowser(x.path); } }}>
      <div className={`ic ${x.kind}`}>{x.kind === 'html' ? 'HTML' : x.kind === 'md' ? 'MD' : 'FILE'}</div>
      <div className="b">
        <div className="t" onClick={() => openDoc(x)}>{x.name}</div>
        <div className="s">{box === 'inbox' && x.from ? (x.from.num ? `from #${x.from.num} ${x.from.title} · ` : `from ${x.from.title} · `) : ''}{kb(x.size)} · {ago(x.mtime)}</div>
        {box === 'outbox' && x.sentTo && x.sentTo.length > 0 && <div className="s">sent to {x.sentTo.map(s => '#' + s.num).join(', ')}</div>}
      </div>
      <button className="btn" onClick={() => openDoc(x)} title={x.kind === 'html' ? 'Preview in a floating window (Space)' : 'Read (Space)'}>{x.kind === 'html' ? 'Preview' : 'Read'}</button>
      <button className="btn" onClick={() => openInBrowser(x.path)} title="Open at full size in its own browser tab (Enter)">Open in new tab ↗</button>
      {box === 'outbox' && <select value="" onChange={async e => { const to = e.target.value; if (!to) return; try { const result = await api.sendDoc(t.id, x.name, to); const tt = tasks.find(y => y.id === to)!; setMsg(`Sent to #${tt.num}.${result.resumed ? ' The task resumed.' : ' The agent received the notice.'}`); load(); } catch (error) { setMsg((error as Error).message); load(); } }}>
        <option value="">Send to task…</option>{others.map(o => <option key={o.id} value={o.id}>#{o.num} {o.title}</option>)}
      </select>}
      {box === 'inbox' && <button className="btn ghost" onClick={async () => { await api.removeInbox(t.id, x.name); load(); }}>Remove</button>}
    </div>
  );
  return (
    <div>
      {msg && <div className="banner">{msg} <button className="btn ghost" onClick={() => setMsg('')}>OK</button></div>}
      <div className="lk-sec"><h3>Inbox · {d.inbox.length}{!t.machine && <label className="btn addfiles">＋ Add files…<input type="file" multiple hidden onChange={async e => { if (e.target.files?.length) { await uploadAll(t.id, e.target.files, setMsg); e.target.value = ''; load(); } }} /></label>}</h3>
        {d.inbox.length ? d.inbox.map(x => row(x, 'inbox')) : <div className="empty">Nothing here yet. Drop files anywhere on this panel (or use Add files…), or send a document from another task's outbox.</div>}
        {d.inbox.length > 0 && <div className="empty" style={{ marginTop: 6 }}>Tell the agent about pending files. <button className="btn" onClick={async () => { try { const r = await api.tellInbox(t.id); setMsg(r.told ? `Sent.${r.resumed ? ' The task resumed.' : ''}` : 'The agent was already told about every file.'); } catch (error) { setMsg((error as Error).message); } }}>Tell the agent now</button></div>}
      </div>
      <div className="lk-sec"><h3>Outbox · {d.outbox.length}</h3>
        {d.outbox.length ? d.outbox.map(x => row(x, 'outbox')) : <div className="empty">The agent has not written documents yet. It saves them to <code>{t.id}/outbox/</code> in the vault, and they appear here.</div>}
      </div>
      <div className="empty" style={{ marginTop: 14 }}>Keys: select a row, <kbd>Space</kbd> reads or previews it, <kbd>Enter</kbd> opens it in a browser tab.</div>
    </div>
  );
}

// ---------- floating windows (mounted outside the React tree so several can be open) ----------
let z = 200, n = 0;
function floating(title: string, sub: string, path: string, body: (el: HTMLElement) => void) {
  const host = document.createElement('div'); host.className = 'floatwin'; host.style.zIndex = String(++z);
  const k = n++ % 6;
  Object.assign(host.style, { left: Math.max(20, innerWidth - 960 - k * 28) + 'px', top: 70 + k * 28 + 'px', width: '900px', height: Math.min(720, innerHeight - 120) + 'px' });
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => { root.unmount(); host.remove(); };
  root.render(<FloatWin title={title} sub={sub} path={path} close={close} host={host} body={body} />);
}
function FloatWin({ title, sub, path, close, host, body }: { title: string; sub: string; path: string; close: () => void; host: HTMLElement; body: (el: HTMLElement) => void }) {
  const inner = useRef<HTMLDivElement>(null);
  useEffect(() => { if (inner.current) body(inner.current); }, []);
  const drag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const sx = e.clientX, sy = e.clientY, l = host.offsetLeft, t = host.offsetTop; host.classList.add('moving');
    const mv = (ev: PointerEvent) => { host.style.left = l + ev.clientX - sx + 'px'; host.style.top = Math.max(0, t + ev.clientY - sy) + 'px'; };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); host.classList.remove('moving'); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  };
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && host.style.zIndex === String(z)) close(); }; addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, []);
  return (
    <>
      <div className="fw-h" onPointerDown={drag} onDoubleClick={() => host.classList.toggle('big')} onMouseDown={() => { host.style.zIndex = String(++z); }}>
        <div className="fw-t"><b>{title}</b><span>{sub}</span></div>
        <button className="btn" onClick={() => openInBrowser(path)} title="Open at full size in its own browser tab">Open in new tab ↗</button>
        <button className="btn icon" onClick={close} title="Close (Esc)">✕</button>
      </div>
      <div className="fw-b" ref={inner} />
    </>
  );
}
export function previewHtml(path: string, name: string, heading?: string) {
  floating(name, path.replace(/^\/Users\/[^/]+/, '~'), path, el => {
    const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts allow-popups'); f.src = fileUrl(path) + (heading ? '#' + encodeURIComponent(heading) : ''); el.appendChild(f);
  });
}
export function readMarkdown(path: string, name: string, location?: { line?: number; heading?: string }) {
  floating(name, path.replace(/^\/Users\/[^/]+/, '~'), path, async el => {
    const text = await fetch(fileUrl(path)).then(r => r.text());
    const div = document.createElement('div'); div.className = 'md doc';
    const tokens = marked.lexer(text).filter(t => t.type !== 'space');
    let line = 1;
    for (const token of tokens) {
      const section = document.createElement('section');
      section.dataset.line = String(line);
      line += token.raw.split('\n').length - 1;
      section.innerHTML = DOMPurify.sanitize(marked.parser([token] as never));
      div.appendChild(section);
    }
    el.appendChild(div);
    decorateDocument(div, path);
    const target = location?.heading
      ? [...div.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')].find(h => h.textContent?.trim().toLowerCase().replace(/\s+/g, '-') === location.heading?.toLowerCase())
      : location?.line ? [...div.querySelectorAll<HTMLElement>('section')].reverse().find(s => Number(s.dataset.line) <= location.line!) : null;
    target?.scrollIntoView({ block: 'start' });
  });
}
