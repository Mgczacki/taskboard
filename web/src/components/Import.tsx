// Import sessions started outside Taskboard. Imported sessions become Suspended tasks;
// opening one resumes the conversation here. Sessions still open in a terminal must be exited there first.
import { useEffect, useMemo, useState } from 'react';
import type { ImportCandidate } from '../api';
import { api, fmtWait, shortPath } from '../api';
import { AgentChip } from './ui';

const ago = (iso: string) => fmtWait(Math.round((Date.now() - Date.parse(iso)) / 60000)) + ' ago';

export function Import({ onClose, onDone }: { onClose: () => void; onDone: (firstId?: string) => void }) {
  const [list, setList] = useState<ImportCandidate[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [agent, setAgent] = useState<'all' | 'claude' | 'codex'>('all');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { api.importList().then(setList).catch(e => setErr(String(e.message || e))); }, []);

  const f = q.trim().toLowerCase();
  const shown = useMemo(() => (list || []).filter(c => (agent === 'all' || c.agent === agent) && (!f || `${c.title} ${c.cwd} ${c.firstPrompt}`.toLowerCase().includes(f))), [list, f, agent]);
  const running = shown.filter(c => c.running), recent = shown.filter(c => !c.running);
  const toggle = (id: string) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const go = async () => {
    const items = (list || []).filter(c => sel.has(c.sessionId));
    if (!items.length) return;
    setBusy(true);
    try {
      const r = await api.importItems(items);
      if (r.errors.length) setErr(r.errors.join(' '));
      onDone(r.made[0]?.id);
    } catch (e) { setErr(String((e as Error).message || e)); setBusy(false); }
  };

  const row = (c: ImportCandidate) => (
    <label key={c.sessionId} className={`imp-row ${sel.has(c.sessionId) ? 'on' : ''}`}>
      <input type="checkbox" checked={sel.has(c.sessionId)} onChange={() => toggle(c.sessionId)} />
      <div className="imp-main">
        <div className="imp-t"><AgentChip a={c.agent} /><b>{c.title}</b>{c.source === 'vscode' && <span className="chip">VS Code</span>}</div>
        <div className="imp-s"><span className="mono">{shortPath(c.cwd)}</span>{c.branch && <span className="mono"> · {c.branch}</span>} · last active {ago(c.updated)}</div>
        {c.lastMessage && <div className="imp-m">{c.lastMessage}</div>}
        {c.running && <div className="imp-run">● Open now in <b>{c.running.tty}</b> (process {c.running.pid}){c.running.exact ? '' : ', matched by folder'}. Exit it there before opening the task here, so two copies never write to one conversation.</div>}
      </div>
    </label>
  );

  return (
    <div className="scrim open" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }} onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
      <div className="modal" style={{ width: 860 }}>
        <header><h2>Import sessions</h2><button className="btn ghost icon" onClick={onClose}>✕</button></header>
        <div className="body">
          <div className="help" style={{ fontSize: 12.5, color: 'var(--muted)' }}>Claude Code and Codex sessions from the last 14 days. Imported sessions start as <b>Suspended</b>; opening one resumes the same conversation inside Taskboard with <code>claude --resume</code> or <code>codex resume</code>. Nothing in <code>~/.claude</code> or <code>~/.codex</code> is changed.</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="imp-q" value={q} onChange={e => setQ(e.target.value)} placeholder="Filter by title, folder or prompt" autoFocus />
            <div className="seg">{(['all', 'claude', 'codex'] as const).map(a => <button key={a} className={agent === a ? 'on' : ''} onClick={() => setAgent(a)}>{a === 'all' ? 'All' : a === 'claude' ? 'Claude Code' : 'Codex'}</button>)}</div>
          </div>
          <div className="imp-list">
            {!list && !err && <div className="empty">Reading sessions…</div>}
            {running.length > 0 && <><div className="fp-group">Open in a terminal now · {running.length}</div>{running.map(row)}</>}
            {recent.length > 0 && <><div className="fp-group">Recent · {recent.length}</div>{recent.map(row)}</>}
            {list && !shown.length && <div className="empty">No sessions match.</div>}
          </div>
          {err && <div className="banner stopped">{err}</div>}
        </div>
        <footer><span style={{ flex: 1, color: 'var(--dim)', fontSize: 12 }}>{sel.size} selected</span><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !sel.size} onClick={go}>{busy ? 'Importing…' : `Import ${sel.size || ''}`}</button></footer>
      </div>
    </div>
  );
}
