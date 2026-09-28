// Graph: how work flows between tasks. Tasks are cards in horizontal lanes; documents a task wrote sit next to it,
// and a document sent to another task's inbox draws an arrow to that task.
//
// Layout is computed, not simulated, so the same data always gives the same positions:
// - Lanes: by Group (a task is drawn once, in the lane of its first group; its other groups show as swatches and an
//   "also in" note, because copying it into every group's lane would split one handoff chain into pieces),
//   by Folder (the project folder the task runs in), or by Status.
// - Columns are ranks along the handoff chains: rank = longest path from a node with no inputs. A task, the
//   document it wrote and the task that received it sit in consecutive columns.
// - Tasks with no links fill the free cells of their lane row by row: waiting on you first, then by task number.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Group, Status, Task } from '../api';
import { ATTN, ORDER, STATUS_LABEL, fmtWait } from '../api';
import '../graph.css';
import { Dot } from './ui';

type Tab = 'terminal' | 'log' | 'docs';
interface Props { tasks: Task[]; groups: Group[]; open: (id: string, tab?: Tab) => void }
interface Edge { from: string; to: string; name: string; at: string }
interface OutDoc { name: string; path: string; kind: 'md' | 'html' | 'other'; mtime: string }
type LaneMode = 'group' | 'folder' | 'status';

const LABEL_W = 180, PADX = 24, CELL_W = 240, DOC_W = 208, COL_GAP = 64, ROW_H = 112, DOC_H = 62, ROW_GAP = 16, PAD_Y = 18;
const STVAR: Record<Status, string> = {
  'needs-you': '--st-needs', working: '--st-working', unread: '--st-unread', idle: '--st-idle', parked: '--st-parked',
  archived: '--st-archived', review: '--st-review', stopped: '--st-stopped', suspended: '--st-idle',
};

interface GNode { id: string; kind: 'task' | 'doc'; lane: string; w: number; h: number; x: number; y: number; row: number; col: number; t?: Task; owner?: string; doc?: OutDoc }
interface GEdge { a: string; b: string; kind: 'wrote' | 'handoff' }
interface Lane { key: string; name: string; color: string; nodes: GNode[]; rows: number; y: number; h: number; alt: boolean; members: number }

// Project folder of a task: the part before "-wt" for worktrees (~/code/app-wt/x → app), else the last segment.
export function folderOf(t: Task): string {
  const p = (t.folder || t.cwd || '').replace(/\/+$/, '');
  const wt = p.match(/([^/]+)-wt\/[^/]+$/);
  if (wt) return wt[1];
  return p.split('/').pop() || '—';
}

function build(tasksAll: Task[], groups: Group[], docsByTask: Record<string, OutDoc[]>, edgesAll: Edge[], mode: LaneMode, showDocs: boolean, showArch: boolean) {
  const tasks = tasksAll.filter(t => showArch || t.status !== 'archived');
  const tset = new Set(tasks.map(t => t.id));
  const laneOfTask = (t: Task) => {
    if (mode === 'group') { const g = groups.find(g => g.tasks.includes(t.id)); return g ? 'g:' + g.id : 'g:__none'; }
    if (mode === 'folder') return 'f:' + folderOf(t);
    return 's:' + t.status;
  };
  // node keys: 't:<task>' and 'd:<owner>/<file>'
  const nodes = new Map<string, GNode>();
  tasks.forEach(t => nodes.set('t:' + t.id, { id: 't:' + t.id, kind: 'task', t, lane: laneOfTask(t), w: CELL_W, h: ROW_H, x: 0, y: 0, row: 0, col: 0 }));
  const edges: GEdge[] = [];
  const handoffs = edgesAll.filter(e => tset.has(e.from) && tset.has(e.to));
  if (showDocs) {
    for (const t of tasks) {
      for (const d of docsByTask[t.id] || []) {
        const id = `d:${t.id}/${d.name}`;
        nodes.set(id, { id, kind: 'doc', owner: t.id, doc: d, lane: laneOfTask(t), w: DOC_W, h: DOC_H, x: 0, y: 0, row: 0, col: 0 });
        edges.push({ a: 't:' + t.id, b: id, kind: 'wrote' });
      }
    }
    for (const e of handoffs) {
      const id = `d:${e.from}/${e.name}`;
      if (!nodes.has(id)) {
        // sent document no longer in the outbox: still draw it so the handoff is visible
        const owner = tasks.find(t => t.id === e.from)!;
        nodes.set(id, { id, kind: 'doc', owner: e.from, doc: { name: e.name, path: '', kind: /\.html?$/i.test(e.name) ? 'html' : /\.(md|markdown|txt)$/i.test(e.name) ? 'md' : 'other', mtime: e.at }, lane: laneOfTask(owner), w: DOC_W, h: DOC_H, x: 0, y: 0, row: 0, col: 0 });
        edges.push({ a: 't:' + e.from, b: id, kind: 'wrote' });
      }
      if (!edges.some(x => x.a === id && x.b === 't:' + e.to)) edges.push({ a: id, b: 't:' + e.to, kind: 'handoff' });
    }
  } else {
    for (const e of handoffs) if (!edges.some(x => x.a === 't:' + e.from && x.b === 't:' + e.to)) edges.push({ a: 't:' + e.from, b: 't:' + e.to, kind: 'handoff' });
  }

  // ranks: longest path from a node without inputs
  const preds = new Map<string, string[]>([...nodes.keys()].map(k => [k, []]));
  edges.forEach(e => preds.get(e.b)?.push(e.a));
  const linked = new Set(edges.flatMap(e => [e.a, e.b]));
  const rank = new Map<string, number>();
  const rk = (id: string, seen = new Set<string>()): number => {
    if (rank.has(id)) return rank.get(id)!;
    if (seen.has(id)) return 0; seen.add(id);
    const p = preds.get(id) || [];
    const r = p.length ? Math.max(...p.map(x => rk(x, seen))) + 1 : 0;
    rank.set(id, r); return r;
  };
  [...linked].sort().forEach(id => rk(id));
  const R = linked.size ? Math.max(...rank.values()) : -1;

  let laneDefs: { key: string; name: string; color: string }[];
  if (mode === 'group') laneDefs = [...groups.map(g => ({ key: 'g:' + g.id, name: g.name, color: g.color })), { key: 'g:__none', name: 'Not in any group', color: 'var(--line2)' }];
  else if (mode === 'folder') laneDefs = [...new Set(tasks.map(folderOf))].sort((a, b) => a.localeCompare(b)).map(f => ({ key: 'f:' + f, name: f, color: 'var(--line2)' }));
  else laneDefs = ORDER.map(s => ({ key: 's:' + s, name: STATUS_LABEL[s], color: `var(${STVAR[s]})` }));

  const lanes: Lane[] = laneDefs.map(l => {
    const ns = [...nodes.values()].filter(n => n.lane === l.key);
    const members = l.key.startsWith('g:') && l.key !== 'g:__none' ? (groups.find(g => 'g:' + g.id === l.key)?.tasks.filter(id => tset.has(id)).length || 0) : ns.filter(n => n.kind === 'task').length;
    return { ...l, nodes: ns, members, rows: 1, y: 0, h: 0, alt: false };
  }).filter(l => l.nodes.length || l.members > 0);

  let numCols = Math.max(R + 1, 4);
  lanes.forEach(l => { numCols = Math.max(numCols, Math.min(6, Math.ceil(Math.sqrt(l.nodes.length * 2.2)))); });

  const rowOf = new Map<string, number>();
  const avgPredRow = (n: GNode) => { const p = (preds.get(n.id) || []).filter(x => rowOf.has(x)); return p.length ? p.reduce((s, x) => s + rowOf.get(x)!, 0) / p.length : 99; };
  const statusOrder = (s: Status) => ORDER.indexOf(s);
  lanes.forEach(l => {
    const grid: (string | undefined)[][] = [];
    const occupy = (r: number, c: number, n: GNode) => { (grid[r] = grid[r] || [])[c] = n.id; rowOf.set(n.id, r); n.row = r; n.col = c; };
    const flow = l.nodes.filter(n => linked.has(n.id));
    for (let c = 0; c <= R; c++) {
      const col = flow.filter(n => rank.get(n.id) === c);
      col.sort((a, b) => avgPredRow(a) - avgPredRow(b) || a.id.localeCompare(b.id));
      col.forEach((n, i) => occupy(i, c, n));
    }
    const loose = l.nodes.filter(n => !linked.has(n.id)).sort((a, b) =>
      (a.t && b.t ? statusOrder(a.t.status) - statusOrder(b.t.status) || a.t.num - b.t.num : a.id.localeCompare(b.id)));
    let r = 0, c = 0;
    loose.forEach(n => {
      while ((grid[r] || [])[c] !== undefined) { c++; if (c >= numCols) { c = 0; r++; } }
      occupy(r, c, n); c++; if (c >= numCols) { c = 0; r++; }
    });
    l.rows = Math.max(1, grid.length);
  });

  let y = 0;
  lanes.forEach((l, li) => {
    l.y = y; l.h = l.nodes.length ? PAD_Y * 2 + l.rows * ROW_H + (l.rows - 1) * ROW_GAP : 96; l.alt = li % 2 === 1;
    l.nodes.forEach(n => {
      n.x = LABEL_W + PADX + n.col * (CELL_W + COL_GAP) + (CELL_W - n.w) / 2;
      n.y = y + PAD_Y + n.row * (ROW_H + ROW_GAP) + (ROW_H - n.h) / 2;
    });
    y += l.h;
  });
  const width = LABEL_W + PADX * 2 + numCols * CELL_W + (numCols - 1) * COL_GAP;
  return { nodes, edges, lanes, width, height: y };
}

function edgePath(a: GNode, b: GNode, kind: GEdge['kind']) {
  const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x - (kind === 'handoff' ? 8 : 0), y2 = b.y + b.h / 2;
  const c = Math.max(36, (x2 - x1) / 2);
  return `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`;
}

export function GraphView({ tasks, groups, open }: Props) {
  const [mode, setMode] = useState<LaneMode>(() => (localStorage.getItem('tb-graph-lanes') as LaneMode) || 'group');
  const [showDocs, setShowDocs] = useState(() => localStorage.getItem('tb-graph-docs') !== '0');
  const [showArch, setShowArch] = useState(false);
  const [edgesAll, setEdges] = useState<Edge[]>([]);
  const [docsByTask, setDocs] = useState<Record<string, OutDoc[]>>({});
  const [tf, setTf] = useState({ x: 16, y: 16, k: 1 });
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const tfRef = useRef(tf); tfRef.current = tf;

  useEffect(() => { localStorage.setItem('tb-graph-lanes', mode); localStorage.setItem('tb-graph-docs', showDocs ? '1' : '0'); }, [mode, showDocs]);

  // documents and handoffs: refetch shortly after the task list changes
  const taskKey = tasks.map(t => `${t.id}:${t.docs?.inbox ?? 0}:${t.docs?.outbox ?? 0}`).join(',');
  useEffect(() => {
    let dead = false;
    const h = setTimeout(async () => {
      try {
        const [e, d] = await Promise.all([fetch('/api/docs/edges').then(r => r.json()), fetch('/api/docs/all').then(r => r.json())]);
        if (!dead) { setEdges(Array.isArray(e) ? e : []); setDocs(d && typeof d === 'object' ? d : {}); }
      } catch { /* server not reachable: keep what we have */ }
    }, 500);
    return () => { dead = true; clearTimeout(h); };
  }, [taskKey]);

  const L = useMemo(() => build(tasks, groups, docsByTask, edgesAll, mode, showDocs, showArch), [tasks, groups, docsByTask, edgesAll, mode, showDocs, showArch]);

  const fit = useCallback(() => {
    const el = stage.current; if (!el) return;
    const W = el.clientWidth;
    const k = Math.max(0.8, Math.min(1, (W - 32) / L.width)); // fit width, never below 80%: text stays readable, tall graphs pan vertically
    setTf({ k, x: Math.max(16, (W - L.width * k) / 2), y: 16 });
  }, [L.width]);
  // fit when the options change (not on every live update, so zoom and pan are kept)
  useEffect(() => { fit(); }, [mode, showDocs, showArch]);
  const fitted = useRef(false);
  useEffect(() => { if (!fitted.current && L.nodes.size) { fitted.current = true; fit(); } }, [L.nodes.size, fit]);
  useEffect(() => { const on = () => fit(); addEventListener('resize', on); return () => removeEventListener('resize', on); }, [fit]);
  useEffect(() => { if (sel && !L.nodes.has(sel)) setSel(null); }, [L, sel]);

  // hover or selection highlights the whole chain, before and after the node
  const focusId = hover || sel;
  const chain = useMemo(() => {
    if (!focusId || !L.nodes.has(focusId)) return null;
    const set = new Set([focusId]), eset = new Set<number>();
    const walk = (cur: string, dir: 1 | -1) => L.edges.forEach((e, i) => {
      const from = dir > 0 ? e.a : e.b, to = dir > 0 ? e.b : e.a;
      if (from === cur && !eset.has(i)) { eset.add(i); set.add(to); walk(to, dir); }
    });
    walk(focusId, 1); walk(focusId, -1);
    return { set, eset };
  }, [focusId, L]);

  const openNode = useCallback((id: string) => {
    const n = L.nodes.get(id); if (!n) return;
    if (n.kind === 'task') open(n.t!.id); else open(n.owner!, 'docs');
  }, [L, open]);

  const select = useCallback((id: string) => {
    setSel(id);
    const n = L.nodes.get(id), el = stage.current; if (!n || !el) return;
    const W = el.clientWidth, H = el.clientHeight, t = { ...tfRef.current };
    const sx = n.x * t.k + t.x, sy = n.y * t.k + t.y, sw = n.w * t.k, sh = n.h * t.k;
    if (sx < 20) t.x += 20 - sx; if (sx + sw > W - 20) t.x -= sx + sw - (W - 20);
    if (sy < 20) t.y += 20 - sy; if (sy + sh > H - 20) t.y -= sy + sh - (H - 20);
    setTf(t);
  }, [L]);

  const zoomAt = (k: number, mx: number, my: number) => setTf(t => { k = Math.max(0.35, Math.min(2, k)); return { k, x: mx - (mx - t.x) * k / t.k, y: my - (my - t.y) * k / t.k }; });

  // keyboard: F fits, arrows move the selection, Enter opens it
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tgt = e.target as HTMLElement;
      if (tgt?.closest?.('input,textarea,select,[contenteditable=true],.xterm,.modal')) return;
      if (document.querySelector('.drawer.open, .scrim.open, .triage.open')) return;
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); fit(); return; }
      if (e.key === 'Enter' && sel) { e.preventDefault(); openNode(sel); return; }
      if (!e.key.startsWith('Arrow')) return;
      e.preventDefault();
      const all = [...L.nodes.values()];
      if (!sel || !L.nodes.has(sel)) { const first = [...all].sort((a, b) => a.y - b.y || a.x - b.x)[0]; if (first) select(first.id); return; }
      const c = L.nodes.get(sel)!, cx = c.x + c.w / 2, cy = c.y + c.h / 2;
      let best: string | null = null, bd = Infinity;
      all.forEach(n => {
        if (n.id === sel) return;
        const dx = n.x + n.w / 2 - cx, dy = n.y + n.h / 2 - cy;
        const ok = e.key === 'ArrowLeft' ? dx < -10 : e.key === 'ArrowRight' ? dx > 10 : e.key === 'ArrowUp' ? dy < -10 : dy > 10;
        if (!ok) return;
        const d = (e.key === 'ArrowLeft' || e.key === 'ArrowRight') ? Math.abs(dx) + Math.abs(dy) * 3 : Math.abs(dy) + Math.abs(dx) * 3;
        if (d < bd) { bd = d; best = n.id; }
      });
      if (best) select(best);
    };
    addEventListener('keydown', on); return () => removeEventListener('keydown', on);
  }, [L, sel, fit, openNode, select]);

  // pan by dragging the background; scroll pans, ⌘/ctrl + scroll zooms
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.gnode')) return;
    const el = stage.current!; el.setPointerCapture(e.pointerId); setPanning(true);
    const s = { x: e.clientX, y: e.clientY, tx: tfRef.current.x, ty: tfRef.current.y };
    const mv = (ev: PointerEvent) => setTf(t => ({ ...t, x: s.tx + ev.clientX - s.x, y: s.ty + ev.clientY - s.y }));
    const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); setPanning(false); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
  };
  useEffect(() => {
    const el = stage.current; if (!el) return;
    const on = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) { const r = el.getBoundingClientRect(); zoomAt(tfRef.current.k * Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top); }
      else setTf(t => ({ ...t, x: t.x - e.deltaX, y: t.y - e.deltaY }));
    };
    el.addEventListener('wheel', on, { passive: false }); return () => el.removeEventListener('wheel', on);
  }, []);

  const nodes = [...L.nodes.values()];
  const nTasks = nodes.filter(n => n.kind === 'task').length, nDocs = nodes.filter(n => n.kind === 'doc').length, nHand = L.edges.filter(e => e.kind === 'handoff').length;
  const zoomBtn = (f: number) => { const el = stage.current; if (el) zoomAt(tf.k * f, el.clientWidth / 2, el.clientHeight / 2); };

  return (
    <div className="graph">
      <div className="gtool">
        <span className="lbl">Lanes by</span>
        <div className="seg">{(['group', 'folder', 'status'] as LaneMode[]).map(m => <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>{m[0].toUpperCase() + m.slice(1)}</button>)}</div>
        <label className="opt"><input type="checkbox" checked={showDocs} onChange={e => setShowDocs(e.target.checked)} /> Documents</label>
        <label className="opt"><input type="checkbox" checked={showArch} onChange={e => setShowArch(e.target.checked)} /> Archived</label>
        <span className="cnt">{nTasks} tasks · {nDocs} documents · {nHand} handoffs</span>
        <span className="sp" />
        <div className="lg">
          {(['needs-you', 'stopped', 'unread', 'working', 'idle'] as Status[]).map(s => <span key={s}><Dot s={s} />{STATUS_LABEL[s]}</span>)}
          <span><svg width="26" height="10"><path d="M1 5h18" stroke="var(--accent)" strokeWidth="1.9" /><path d="M18 1.5 25 5l-7 3.5z" fill="var(--accent)" /></svg>handoff</span>
          <span><svg width="22" height="10"><path d="M1 5h20" stroke="var(--line2)" strokeWidth="1.6" /></svg>wrote</span>
        </div>
        <button className="btn icon" onClick={() => zoomBtn(1 / 1.2)} title="Zoom out">−</button><span className="zl">{Math.round(tf.k * 100)}%</span><button className="btn icon" onClick={() => zoomBtn(1.2)} title="Zoom in">＋</button><button className="btn" onClick={fit} title="Fit (F)">Fit</button>
      </div>
      <div className={`gstage ${panning ? 'panning' : ''}`} ref={stage} onPointerDown={onPointerDown} onClick={e => { if (!(e.target as HTMLElement).closest('.gnode')) setSel(null); }}>
        {!nodes.length ? <div className="gempty">{tasks.length ? 'No tasks to show. Turn on “Archived” to see archived tasks.' : 'No tasks yet. Press N to start an agent.'}</div> :
          <div className={`gworld ${chain ? 'focusing' : ''}`} style={{ width: L.width, height: L.height, transform: `translate(${tf.x}px,${tf.y}px) scale(${tf.k})` }}>
            {L.lanes.map((l, i) => {
              const ts = l.nodes.filter(n => n.kind === 'task').map(n => n.t!);
              const elsewhere = l.members - ts.length;
              return (
                <div key={l.key} className={`glane ${l.alt ? 'alt' : ''} ${i === L.lanes.length - 1 ? 'last' : ''}`} style={{ top: l.y, height: l.h, width: L.width }}>
                  <div className="glane-label">
                    <div className="nm"><span className="sw" style={{ background: l.color }} />{l.name}</div>
                    <div className="ct">{l.members} task{l.members === 1 ? '' : 's'}{elsewhere > 0 ? ` · ${elsewhere} shown in a lane above` : ''}</div>
                    {mode !== 'status' && <div className="sum">{ORDER.filter(s => ts.some(t => t.status === s)).map(s => <span key={s} title={STATUS_LABEL[s]}><Dot s={s} />{ts.filter(t => t.status === s).length}</span>)}</div>}
                  </div>
                </div>
              );
            })}
            <svg className="gedges" width={L.width} height={L.height}>
              <defs><marker id="garr" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0 10 5 0 10z" style={{ fill: 'var(--accent)' }} /></marker></defs>
              {L.edges.map((e, i) => { const a = L.nodes.get(e.a), b = L.nodes.get(e.b); if (!a || !b) return null; return <path key={i} className={`gedge ${e.kind} ${chain?.eset.has(i) ? 'hl' : ''}`} d={edgePath(a, b, e.kind)} markerEnd={e.kind === 'handoff' ? 'url(#garr)' : undefined} />; })}
            </svg>
            {nodes.map(n => <NodeCard key={n.id} n={n} groups={groups} mode={mode} sel={sel === n.id} hl={!!chain?.set.has(n.id)}
              onEnter={() => setHover(n.id)} onLeave={() => setHover(null)} onClick={() => { select(n.id); openNode(n.id); }} />)}
          </div>}
      </div>
    </div>
  );
}

function NodeCard({ n, groups, mode, sel, hl, onEnter, onLeave, onClick }: { n: GNode; groups: Group[]; mode: LaneMode; sel: boolean; hl: boolean; onEnter: () => void; onLeave: () => void; onClick: () => void }) {
  const style = { left: n.x, top: n.y, width: n.w, height: n.h } as React.CSSProperties;
  const cls = `${sel ? 'sel' : ''} ${hl ? 'hl' : ''}`;
  if (n.kind === 'doc') {
    const d = n.doc!;
    return (
      <div className={`gnode doc ${cls}`} style={style} title={d.path || d.name} onPointerEnter={onEnter} onPointerLeave={onLeave} onClick={onClick}>
        <span className="ic" /><div className="dn">{d.name}</div>
        <div className="rv"><span className="k">{d.kind === 'html' ? 'HTML' : d.kind === 'md' ? 'MD' : 'FILE'}</span>{d.path ? 'in outbox' : 'sent'}</div>
      </div>
    );
  }
  const t = n.t!, attn = ATTN.includes(t.status);
  const gs = groups.filter(g => g.tasks.includes(t.id));
  const primary = mode === 'group' ? gs[0] : undefined, others = gs.filter(g => g !== primary);
  let line: React.ReactNode;
  if (t.status === 'needs-you') line = <><b>Asks</b> {t.ask || ''}</>;
  else if (t.status === 'stopped') line = <><b>Stopped</b> {t.stopReason || t.ask || ''}</>;
  else if (t.status === 'review') line = <><b>Review</b> {t.ask || ''}</>;
  else if (t.status === 'suspended') line = 'Suspended · resumes when you open it';
  else if (t.openElsewhere && !t.ask) line = <><b>Open in {t.openElsewhere?.tty || 'another terminal'}</b></>;
  else line = t.now || t.goal || '';
  const io = (t.docs?.inbox || 0) + (t.docs?.outbox || 0);
  const shown = mode === 'group' ? others : gs;
  return (
    <div className={`gnode task ${t.status} ${cls}`} style={{ ...style, '--sc': `var(${STVAR[t.status]})` } as React.CSSProperties} onPointerEnter={onEnter} onPointerLeave={onLeave} onClick={onClick}>
      <div className="r1"><Dot s={t.status} /><span className="num">#{t.num}</span>{attn && <span className="wait">waiting {fmtWait(t.waitMin)}</span>}<span className="ag">{t.agent === 'claude' ? 'Claude' : 'Codex'}</span></div>
      <div className="ti">{t.title}</div>
      <div className="ln">{line}</div>
      <div className="ft">
        {shown.map(g => <i key={g.id} style={{ background: g.color }} title={g.name} />)}
        {mode === 'group' && others.length > 0 ? <span className="also">also in {others.map(g => g.name).join(', ')}</span> : <span>{mode === 'folder' ? (t.branch || '') : folderOf(t)}</span>}
        {io > 0 && <span className="io">in {t.docs?.inbox || 0} · out {t.docs?.outbox || 0}</span>}
      </div>
    </div>
  );
}
