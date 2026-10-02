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
// - People (the "People" checkbox): Slack members that a task, the controller or the user sent a message to, or whose
//   message was routed to a task. They are in their own "People" lane at the bottom in every lane layout, with the
//   Controller, You and Unknown sender nodes for messages that no task proposed. Data: GET /api/a2anotes/graph.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Group, Status, Task } from '../api';
import { AGENT_NAME, ATTN, ORDER, STATUS_LABEL, fmtWait } from '../api';
import '../graph.css';
import { Dot } from './ui';
import { hit, inBrowser } from '../keys';
import { Face, MessagePanel, type MailBrief, type MailGraph, type MailPerson } from './GraphMail';
import type { LinkKind } from '../api';
import { current, depOpen, linkedSets, setLead } from '../links';

type Tab = 'terminal' | 'log' | 'docs';
interface Props { tasks: Task[]; groups: Group[]; open: (id: string, tab?: Tab) => void }
interface Edge { from: string; to: string; name: string; at: string }
interface OutDoc { name: string; path: string; kind: 'md' | 'html' | 'other'; mtime: string }
type LaneMode = 'group' | 'folder' | 'status' | 'links';

const PEOPLE = 'p:people', PERSON_W = 220, PERSON_H = 62;
const SOURCES: Record<string, string> = { controller: 'Controller', user: 'You', unknown: 'Unknown sender' };
const LABEL_W = 180, PADX = 24, CELL_W = 240, DOC_W = 208, COL_GAP = 64, ROW_H = 112, DOC_H = 62, ROW_GAP = 16, PAD_Y = 18;
const STVAR: Record<Status, string> = {
  'needs-you': '--st-needs', working: '--st-working', unread: '--st-unread', idle: '--st-idle', parked: '--st-parked',
  archived: '--st-archived', review: '--st-review', stopped: '--st-stopped', suspended: '--st-idle',
};

interface PersonStats { sent: number; unsent: number; received: number; unrouted: number; last: string }
interface GNode { id: string; kind: 'task' | 'doc' | 'person' | 'source' | 'more'; lane: string; w: number; h: number; x: number; y: number; row: number; col: number; t?: Task; owner?: string; doc?: OutDoc; docOrder?: number; extraDocs?: number; expanded?: boolean; person?: MailPerson; stats?: PersonStats; src?: string }
// message edges: ids of the messages on the edge, dashed (pending) while none of them is sent
// link edges (links.ts): from the task that must come first to the task after it; relatedTo does not count for ranks
interface GEdge { a: string; b: string; kind: 'wrote' | 'handoff' | 'message' | 'link' | 'parent'; ids?: string[]; pending?: boolean; last?: string; lk?: LinkKind; open?: boolean; folded?: boolean; note?: string; owner?: string; norank?: boolean }
interface Lane { key: string; name: string; color: string; nodes: GNode[]; rows: number; y: number; h: number; alt: boolean; members: number }

// Project folder of a task: the part before "-wt" for worktrees (~/code/app-wt/x → app), else the last segment.
export function folderOf(t: Task): string {
  const p = (t.folder || t.cwd || '').replace(/\/+$/, '');
  const wt = p.match(/([^/]+)-wt\/[^/]+$/);
  if (wt) return wt[1];
  return p.split('/').pop() || '—';
}

function build(tasksAll: Task[], groups: Group[], docsByTask: Record<string, OutDoc[]>, edgesAll: Edge[], mode: LaneMode, showDocs: boolean, showArch: boolean, mail: MailGraph, showPeople: boolean, expandedDocs: Set<string>, showLinks = true, startGroup = '') {
  let tasks = tasksAll.filter(t => showArch || t.status !== 'archived');
  // Lanes by links show only the tasks and their links: documents, handoffs and people would cross the link lines.
  if (mode === 'links') { showDocs = false; showPeople = false; edgesAll = []; }
  // Lanes by links: one lane for each set of linked tasks. Start from a group: only the sets that hold a task of it.
  const sets = mode === 'links' ? linkedSets(tasks) : [];
  if (mode === 'links' && startGroup) {
    const g = groups.find(x => x.id === startGroup);
    const keep = new Set(sets.filter(set => set.some(t => g?.tasks.includes(t.id))).flat().map(t => t.id));
    g?.tasks.forEach(id => keep.add(id));
    tasks = tasks.filter(t => keep.has(t.id));
  }
  const setOf = new Map<string, number>(); sets.forEach((set, i) => set.forEach(t => setOf.set(t.id, i)));
  const tset = new Set(tasks.map(t => t.id));
  const laneOfTask = (t: Task) => {
    if (mode === 'links') return setOf.has(t.id) ? 'l:' + setOf.get(t.id) : 'l:__none';
    if (mode === 'group') { const g = groups.find(g => g.tasks.includes(t.id)); return g ? 'g:' + g.id : 'g:__none'; }
    if (mode === 'folder') return 'f:' + folderOf(t);
    return 's:' + t.status;
  };
  // node keys: 't:<task>' and 'd:<owner>/<file>'
  const nodes = new Map<string, GNode>();
  tasks.forEach(t => nodes.set('t:' + t.id, { id: 't:' + t.id, kind: 'task', t, lane: laneOfTask(t), w: CELL_W, h: ROW_H, x: 0, y: 0, row: 0, col: 0 }));
  const edges: GEdge[] = [];
  if (showLinks || mode === 'links') {
    for (const t of tasks) for (const l of t.links || []) {
      const open = l.kind === 'dependsOn' && depOpen(l, tasksAll);
      const other = l.kind === 'dependsOn' && open ? current(l.to, tasksAll) : l.to;
      if (!tset.has(other)) continue;
      const base = { kind: 'link' as const, lk: l.kind, open, folded: l.folded, note: l.note, owner: t.id };
      if (l.kind === 'dependsOn' || l.kind === 'followUpOf') edges.push({ ...base, a: 't:' + other, b: 't:' + t.id });
      else if (l.kind === 'replaces') edges.push({ ...base, a: 't:' + other, b: 't:' + t.id });
      else edges.push({ ...base, a: 't:' + t.id, b: 't:' + other, norank: true });
    }
    if (mode === 'links') for (const t of tasks) if (t.parent && t.parent !== 'controller' && tset.has(t.parent) && !edges.some(e => e.kind === 'link' && ((e.a === 't:' + t.parent && e.b === 't:' + t.id) || (e.b === 't:' + t.parent && e.a === 't:' + t.id))))
      edges.push({ kind: 'parent', a: 't:' + t.parent, b: 't:' + t.id });
  }
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
  // Collapse after adding sent files, so handoffs cannot bypass the three-file limit.
  if (showDocs) {
    for (const t of tasks) {
      const docs = [...nodes.values()].filter(n => n.kind === 'doc' && n.owner === t.id)
        .sort((a, b) => Date.parse(b.doc!.mtime) - Date.parse(a.doc!.mtime) || a.id.localeCompare(b.id));
      docs.forEach((n, i) => { n.docOrder = i < 3 ? i : i + 1; });
      if (docs.length <= 3) continue;
      const id = 'more:' + t.id, expanded = expandedDocs.has(t.id);
      nodes.set(id, { id, kind: 'more', owner: t.id, extraDocs: docs.length - 3, expanded, docOrder: 3,
        lane: laneOfTask(t), w: DOC_W, h: DOC_H, x: 0, y: 0, row: 0, col: 0 });
      edges.push({ a: 't:' + t.id, b: id, kind: 'wrote' });
      if (!expanded) {
        const hidden = new Set(docs.slice(3).map(n => n.id));
        hidden.forEach(key => nodes.delete(key));
        for (let i = edges.length - 1; i >= 0; i--) {
          const e = edges[i];
          if (hidden.has(e.b)) edges.splice(i, 1);
          else if (hidden.has(e.a)) e.a = id;
        }
      }
    }
  }
  if (showPeople) {
    // One edge for each sender and receiver pair. A message proposed by a hidden (archived) task is left out.
    const addMsg = (a: string, b: string, m: MailBrief, sent: boolean) => {
      let e = edges.find(x => x.kind === 'message' && x.a === a && x.b === b);
      if (!e) edges.push(e = { a, b, kind: 'message', ids: [], pending: true, last: '' });
      e.ids!.push(m.id); if (sent) e.pending = false;
      const at = m.sentAt || m.created; if (at > e.last!) e.last = at;
    };
    const personNode = (m: MailBrief) => {
      const id = 'p:' + m.person;
      if (!nodes.has(id)) {
        const person = mail.people.find(p => p.user === m.person) || { user: m.person, name: m.person, picture: '' };
        nodes.set(id, { id, kind: 'person', person, stats: { sent: 0, unsent: 0, received: 0, unrouted: 0, last: '' }, lane: PEOPLE, w: PERSON_W, h: PERSON_H, x: 0, y: 0, row: 0, col: 0 });
      }
      const n = nodes.get(id)!; const at = m.sentAt || m.created; if (at > n.stats!.last) n.stats!.last = at;
      return n;
    };
    for (const m of mail.messages) {
      if (m.dismissedAt && !showArch) continue;
      if (m.direction === 'outbox') {
        const pb = m.proposedBy;
        let from: string;
        if (pb?.actor === 'task' && pb.task) { if (!tset.has(pb.task)) continue; from = 't:' + pb.task; }
        else {
          const k = pb?.actor === 'controller' || pb?.actor === 'user' ? pb.actor : 'unknown';
          from = 'x:' + k;
          if (!nodes.has(from)) nodes.set(from, { id: from, kind: 'source', src: k, stats: { sent: 0, unsent: 0, received: 0, unrouted: 0, last: '' }, lane: PEOPLE, w: PERSON_W, h: PERSON_H, x: 0, y: 0, row: 0, col: 0 });
          const st = nodes.get(from)!.stats!; if (m.sentAt) st.sent++; else st.unsent++;
        }
        const n = personNode(m);
        if (m.sentAt) n.stats!.sent++; else n.stats!.unsent++;
        addMsg(from, n.id, m, !!m.sentAt);
      } else {
        const n = personNode(m);
        n.stats!.received++;
        if (!m.routes.length) n.stats!.unrouted++;
        for (const r of m.routes) if (tset.has(r.task)) addMsg(n.id, 't:' + r.task, m, true);
      }
    }
  }

  // ranks: longest path from a node without inputs
  // A person who got a message and also sent one back to a task would make a cycle. For ranks, only the messages to
  // that person count, so the person is to the right of the task and the reply arrow goes back to the left.
  const receives = new Set(edges.filter(e => e.kind === 'message' && e.b.startsWith('p:')).map(e => e.b));
  const preds = new Map<string, string[]>([...nodes.keys()].map(k => [k, []]));
  edges.forEach(e => { if (!e.norank && !(e.kind === 'message' && receives.has(e.a))) preds.get(e.b)?.push(e.a); });
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
  else if (mode === 'links') laneDefs = [...sets.map((set, i) => ({ key: 'l:' + i, name: `Linked set of #${setLead(set).num}`, color: 'var(--accent)' })), { key: 'l:__none', name: 'No links', color: 'var(--line2)' }];
  else laneDefs = ORDER.map(s => ({ key: 's:' + s, name: STATUS_LABEL[s], color: `var(${STVAR[s]})` }));
  if (showPeople) laneDefs.push({ key: PEOPLE, name: 'People', color: 'var(--st-review)' });

  const lanes: Lane[] = laneDefs.map(l => {
    const ns = [...nodes.values()].filter(n => n.lane === l.key);
    const members = l.key === PEOPLE ? ns.filter(n => n.kind === 'person').length
      : l.key.startsWith('g:') && l.key !== 'g:__none' ? (groups.find(g => 'g:' + g.id === l.key)?.tasks.filter(id => tset.has(id)).length || 0) : ns.filter(n => n.kind === 'task').length;
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
      col.sort((a, b) => avgPredRow(a) - avgPredRow(b) || (a.owner && b.owner ? a.owner.localeCompare(b.owner) || (a.docOrder ?? 0) - (b.docOrder ?? 0) : 0) || a.id.localeCompare(b.id));
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

// A cubic curve from the right side of a to the left side of b. An edge to a node on the left (a reply from a person
// to the task that wrote to them) goes from the left side of a to the right side of b. For nodes in the same column
// it loops out to the left. mx, my: the middle of the curve, where the message count goes.
// both: a message edge that has an edge in the other direction (a task and a person who replied). The two curves
// then move 8px apart, and each count sits at 30% of its curve from its start, so the counts do not overlap.
function edgePath(a: GNode, b: GNode, kind: GEdge['kind'], both = false) {
  const off = both ? (a.kind === 'person' ? 8 : -8) : 0;
  const tip = kind === 'wrote' ? 0 : 8, y1 = a.y + a.h / 2 + off, y2 = b.y + b.h / 2 + off;
  let x1: number, x2: number, c1: number, c2: number;
  if (a.x + a.w <= b.x) { x1 = a.x + a.w; x2 = b.x - tip; c1 = c2 = Math.max(36, (x2 - x1) / 2); }
  else if (b.x + b.w <= a.x) { x1 = a.x; x2 = b.x + b.w + tip; c1 = c2 = -Math.max(36, (x1 - x2) / 2); }
  else { x1 = a.x; x2 = b.x - tip; c1 = -60; c2 = 60; }
  const p1x = x1 + c1, p2x = x2 - c2;
  // a point of the cubic curve at t: (1-t)^3 P0 + 3(1-t)^2 t P1 + 3(1-t) t^2 P2 + t^3 P3
  const t = both ? 0.3 : 0.5, u = 1 - t, w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return { d: `M${x1},${y1} C${p1x},${y1} ${p2x},${y2} ${x2},${y2}`, mx: w[0] * x1 + w[1] * p1x + w[2] * p2x + w[3] * x2, my: w[0] * y1 + w[1] * y1 + w[2] * y2 + w[3] * y2 };
}

// How far the view can move. On each axis the empty space past the content is at most MARGIN of the viewport,
// and never more than MARGIN_MAX px. Content smaller than the viewport can move anywhere inside it, PAD px from each edge.
const MARGIN = 0.25, MARGIN_MAX = 240, PAD = 16;
type View = { x: number; y: number; k: number };
function clampAxis(p: number, viewport: number, content: number) {
  const m = Math.max(PAD, Math.min(MARGIN_MAX, viewport * MARGIN));
  const lo = Math.min(viewport - m - content, PAD), hi = Math.max(m, viewport - PAD - content);
  return Math.max(lo, Math.min(hi, p));
}
function clampView(t: View, el: HTMLElement | null, w: number, h: number): View {
  if (!el || !el.clientWidth) return t;
  return { k: t.k, x: clampAxis(t.x, el.clientWidth, w * t.k), y: clampAxis(t.y, el.clientHeight, h * t.k) };
}

export function GraphView({ tasks, groups, open }: Props) {
  const [mode, setMode] = useState<LaneMode>(() => (localStorage.getItem('tb-graph-lanes') as LaneMode) || 'group');
  const [showDocs, setShowDocs] = useState(() => localStorage.getItem('tb-graph-docs') !== '0');
  const [expandedDocs, setExpandedDocs] = useState<Set<string>>(() => new Set());
  const [showArch, setShowArch] = useState(false);
  const [showLinks, setShowLinks] = useState(() => localStorage.getItem('tb-graph-links') !== '0');
  const [startGroup, setStartGroup] = useState(() => localStorage.getItem('tb-graph-start') || '');
  const [showPeople, setShowPeople] = useState(() => localStorage.getItem('tb-graph-people') !== '0');
  const [mail, setMail] = useState<MailGraph>({ people: [], messages: [] });
  // the message panel: all messages of a node, or the messages on the edge from a to b
  const [panel, setPanel] = useState<{ node: string } | { a: string; b: string } | null>(null);
  const [edgesAll, setEdges] = useState<Edge[]>([]);
  const [docsByTask, setDocs] = useState<Record<string, OutDoc[]>>({});
  const [tf, setTfRaw] = useState<View>({ x: PAD, y: PAD, k: 1 });
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const tfRef = useRef(tf); tfRef.current = tf;

  useEffect(() => { localStorage.setItem('tb-graph-lanes', mode); localStorage.setItem('tb-graph-docs', showDocs ? '1' : '0'); localStorage.setItem('tb-graph-people', showPeople ? '1' : '0'); localStorage.setItem('tb-graph-links', showLinks ? '1' : '0'); localStorage.setItem('tb-graph-start', startGroup); }, [mode, showDocs, showPeople, showLinks, startGroup]);

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
  // people and messages: the task list does not change when a message arrives, so load them every 30 seconds too
  useEffect(() => {
    if (!showPeople) return;
    let dead = false;
    const load = () => fetch('/api/a2anotes/graph').then(r => r.ok ? r.json() : null).then(d => { if (!dead && d && Array.isArray(d.messages)) setMail(d); }).catch(() => {});
    const h = setTimeout(load, 500), iv = setInterval(load, 30_000);
    return () => { dead = true; clearTimeout(h); clearInterval(iv); };
  }, [taskKey, showPeople]);

  const L = useMemo(() => build(tasks, groups, docsByTask, edgesAll, mode, showDocs, showArch, mail, showPeople, expandedDocs, showLinks, startGroup), [tasks, groups, docsByTask, edgesAll, mode, showDocs, showArch, mail, showPeople, expandedDocs, showLinks, startGroup]);
  // every view change goes through clampView, so the content cannot leave the screen
  const size = useRef({ w: L.width, h: L.height }); size.current = { w: L.width, h: L.height };
  const setTf = useCallback((v: View | ((t: View) => View)) => setTfRaw(t => clampView(typeof v === 'function' ? v(t) : v, stage.current, size.current.w, size.current.h)), []);
  // live updates change the content size: move the view back inside the new limits
  useEffect(() => { setTf(t => t); }, [L.width, L.height, setTf]);

  const fit = useCallback(() => {
    const el = stage.current; if (!el) return;
    const W = el.clientWidth;
    const k = Math.max(0.8, Math.min(1, (W - 32) / L.width)); // fit width, never below 80%: text stays readable, tall graphs pan vertically
    setTf({ k, x: Math.max(PAD, (W - L.width * k) / 2), y: PAD });
  }, [L.width, setTf]);
  // fit when the options change (not on every live update, so zoom and pan are kept)
  useEffect(() => { fit(); }, [mode, showDocs, showArch, showPeople, showLinks, startGroup]);
  const fitted = useRef(false);
  useEffect(() => { if (!fitted.current && L.nodes.size) { fitted.current = true; fit(); } }, [L.nodes.size, fit]);
  useEffect(() => { const on = () => fit(); addEventListener('resize', on); return () => removeEventListener('resize', on); }, [fit]);
  useEffect(() => { if (sel && !L.nodes.has(sel)) setSel(null); }, [L, sel]);
  useEffect(() => { if (panel && !L.nodes.has('node' in panel ? panel.node : panel.a)) setPanel(null); }, [L, panel]);

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
    if (n.kind === 'more') {
      setExpandedDocs(previous => {
        const next = new Set(previous);
        if (next.has(n.owner!)) next.delete(n.owner!); else next.add(n.owner!);
        return next;
      });
      return;
    }
    if (n.kind === 'task') open(n.t!.id); else if (n.kind === 'doc') open(n.owner!, 'docs'); else setPanel({ node: id });
  }, [L, open]);

  const select = useCallback((id: string) => {
    setSel(id);
    const n = L.nodes.get(id), el = stage.current; if (!n || !el) return;
    const W = el.clientWidth, H = el.clientHeight, t = { ...tfRef.current };
    const sx = n.x * t.k + t.x, sy = n.y * t.k + t.y, sw = n.w * t.k, sh = n.h * t.k;
    if (sx < 20) t.x += 20 - sx; if (sx + sw > W - 20) t.x -= sx + sw - (W - 20);
    if (sy < 20) t.y += 20 - sy; if (sy + sh > H - 20) t.y -= sy + sh - (H - 20);
    setTf(t);
  }, [L, setTf]);

  const zoomAt = (k: number, mx: number, my: number) => setTf(t => { k = Math.max(0.35, Math.min(2, k)); return { k, x: mx - (mx - t.x) * k / t.k, y: my - (my - t.y) * k / t.k }; });

  // keyboard: ⌃⌥F (keys.ts: graphFit) fits, arrows move the selection, Enter opens it
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      if (tgt?.closest?.('input,textarea,select,[contenteditable=true],.xterm,.modal') || inBrowser(e)) return;
      if (document.querySelector('.drawer.open, .scrim.open, .triage.open')) return;
      if (e.key === 'Escape' && panel) { e.preventDefault(); setPanel(null); return; }
      if (tgt?.closest?.('.gpanel, button')) return;
      if (hit(e, 'graphFit')) { e.preventDefault(); fit(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
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
  }, [L, sel, fit, openNode, select, panel]);

  // pan by dragging the background; scroll pans, ⌘/ctrl + scroll zooms
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.gnode, .gclick')) return;
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
  }, [setTf]);

  const nodes = [...L.nodes.values()];
  const nTasks = nodes.filter(n => n.kind === 'task').length, nDocs = nodes.reduce((sum, n) => sum + (n.kind === 'doc' ? 1 : n.kind === 'more' && !n.expanded ? n.extraDocs! : 0), 0), nHand = L.edges.filter(e => e.kind === 'handoff').length;
  const nPeople = nodes.filter(n => n.kind === 'person').length, nMsg = nodes.reduce((s, n) => s + (n.kind === 'person' ? n.stats!.sent + n.stats!.unsent + n.stats!.received : 0), 0);

  // what the message panel shows, from the current layout so that it follows live updates
  const shown = (m: MailBrief) => showArch || !m.dismissedAt;
  const nodeName = (id: string) => { const n = L.nodes.get(id); return !n ? id : n.kind === 'task' ? `#${n.t!.num} ${n.t!.title}` : n.kind === 'person' ? n.person!.name : SOURCES[n.src!] || id; };
  let panelView: React.ReactNode = null;
  if (panel) {
    const close = () => setPanel(null);
    const personId = 'node' in panel ? panel.node : [panel.a, panel.b].find(x => x.startsWith('p:'));
    const pn = personId ? L.nodes.get(personId) : undefined;
    const person = pn?.kind === 'person' ? pn.person : undefined;
    const title = person ? person.name : nodeName('node' in panel ? panel.node : panel.a);
    let msgs: MailBrief[];
    if ('node' in panel && person) msgs = mail.messages.filter(m => m.person === person.user && shown(m));
    else {
      const ids = new Set(L.edges.filter(e => e.kind === 'message' && ('node' in panel ? e.a === panel.node : e.a === panel.a && e.b === panel.b)).flatMap(e => e.ids!));
      msgs = mail.messages.filter(m => ids.has(m.id));
    }
    const st = (pn || L.nodes.get('node' in panel ? panel.node : ''))?.stats; // a person, or the Controller, You or Unknown sender node
    const sub = [person?.user, st?.sent && `${st.sent} sent`, st?.unsent && `${st.unsent} not sent`, st?.received && `${st.received} received`, st?.unrouted && `${st.unrouted} not routed`].filter(Boolean).join(' · ');
    const note = 'node' in panel ? undefined : <>Messages from <b>{nodeName(panel.a)}</b> to <b>{nodeName(panel.b)}</b></>;
    panelView = <MessagePanel title={title} person={person} sub={sub} note={note} messages={msgs} tasks={tasks} onClose={close}
      onShowAll={person && !('node' in panel) ? () => setPanel({ node: personId! }) : undefined} />;
  }
  const zoomBtn = (f: number) => { const el = stage.current; if (el) zoomAt(tf.k * f, el.clientWidth / 2, el.clientHeight / 2); };

  return (
    <div className="graph">
      <div className="gtool">
        <span className="lbl">Lanes by</span>
        <div className="seg">{(['group', 'folder', 'status', 'links'] as LaneMode[]).map(m => <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)} title={m === 'links' ? 'One lane for each set of linked tasks; a task that must finish first is to the left' : undefined}>{m[0].toUpperCase() + m.slice(1)}</button>)}</div>
        {mode === 'links' && <label className="opt">Start from <select value={startGroup} onChange={e => setStartGroup(e.target.value)} aria-label="Start from"><option value="">All tasks</option>{groups.map(g => <option key={g.id} value={g.id}>Group: {g.name}</option>)}</select></label>}
        {mode !== 'links' && <label className="opt"><input type="checkbox" checked={showLinks} onChange={e => setShowLinks(e.target.checked)} /> Links</label>}
        {mode !== 'links' && <><label className="opt"><input type="checkbox" checked={showDocs} onChange={e => setShowDocs(e.target.checked)} /> Documents</label>
        <label className="opt"><input type="checkbox" checked={showPeople} onChange={e => setShowPeople(e.target.checked)} /> People</label></>}
        <label className="opt"><input type="checkbox" checked={showArch} onChange={e => setShowArch(e.target.checked)} /> Archived</label>
        <span className="cnt">{nTasks} tasks · {nDocs} documents · {nHand} handoffs{showPeople && ` · ${nPeople} people · ${nMsg} messages`}</span>
        <span className="sp" />
        <div className="lg">
          {(['needs-you', 'stopped', 'unread', 'working', 'idle'] as Status[]).map(s => <span key={s}><Dot s={s} />{STATUS_LABEL[s]}</span>)}
          <span><svg width="26" height="10"><path d="M1 5h18" stroke="var(--accent)" strokeWidth="1.9" /><path d="M18 1.5 25 5l-7 3.5z" fill="var(--accent)" /></svg>handoff</span>
          <span><svg width="22" height="10"><path d="M1 5h20" stroke="var(--line2)" strokeWidth="1.6" /></svg>wrote</span>
          {(showLinks || mode === 'links') && L.edges.some(e => e.kind === 'link') && <><span><svg width="26" height="10"><path d="M1 5h18" stroke="var(--st-stopped)" strokeWidth="2.2" /><path d="M18 1.5 25 5l-7 3.5z" fill="var(--st-stopped)" /></svg>blocks</span>
            <span><svg width="26" height="10"><path d="M1 5h18" stroke="var(--dim)" strokeWidth="1.6" strokeDasharray="6 4" /><path d="M18 1.5 25 5l-7 3.5z" fill="var(--dim)" /></svg>replaced by</span>
            <span><svg width="22" height="10"><path d="M1 5h20" stroke="var(--accent)" strokeWidth="2" strokeDasharray="1 4" strokeLinecap="round" /></svg>follow-up, related</span></>}
          {showPeople && <><span><svg width="26" height="10"><path d="M1 5h18" stroke="var(--st-review)" strokeWidth="1.9" /><path d="M18 1.5 25 5l-7 3.5z" fill="var(--st-review)" /></svg>message</span>
            <span><svg width="26" height="10"><path d="M1 5h18" stroke="var(--st-review)" strokeWidth="1.7" strokeDasharray="5 4" /><path d="M18 1.5 25 5l-7 3.5z" fill="var(--st-review)" /></svg>not sent yet</span></>}
        </div>
        <button className="btn icon" onClick={() => zoomBtn(1 / 1.2)} title="Zoom out">−</button><span className="zl">{Math.round(tf.k * 100)}%</span><button className="btn icon" onClick={() => zoomBtn(1.2)} title="Zoom in">＋</button><button className="btn" onClick={fit} title="Fit (F)">Fit</button>
      </div>
      <div className={`gstage ${panning ? 'panning' : ''}`} ref={stage} onPointerDown={onPointerDown} onClick={e => { if (!(e.target as HTMLElement).closest('.gnode, .gclick')) setSel(null); }}>
        {!nodes.length ? <div className="gempty">{tasks.length ? 'No tasks to show. Turn on “Archived” to see archived tasks.' : 'No tasks yet. Press N to start an agent.'}</div> :
          <div className={`gworld ${chain ? 'focusing' : ''}`} style={{ width: L.width, height: L.height, transform: `translate(${tf.x}px,${tf.y}px) scale(${tf.k})` }}>
            {L.lanes.map((l, i) => {
              const ts = l.nodes.filter(n => n.kind === 'task').map(n => n.t!);
              const elsewhere = l.members - ts.length;
              return (
                <div key={l.key} className={`glane ${l.alt ? 'alt' : ''} ${i === L.lanes.length - 1 ? 'last' : ''}`} style={{ top: l.y, height: l.h, width: L.width }}>
                  <div className="glane-label">
                    <div className="nm"><span className="sw" style={{ background: l.color }} />{l.name}</div>
                    <div className="ct">{l.key === PEOPLE ? `${l.members} ${l.members === 1 ? 'person' : 'people'}` : <>{l.members} task{l.members === 1 ? '' : 's'}{elsewhere > 0 ? ` · ${elsewhere} shown in a lane above` : ''}</>}</div>
                    {mode !== 'status' && l.key !== PEOPLE && <div className="sum">{ORDER.filter(s => ts.some(t => t.status === s)).map(s => <span key={s} title={STATUS_LABEL[s]}><Dot s={s} />{ts.filter(t => t.status === s).length}</span>)}</div>}
                  </div>
                </div>
              );
            })}
            <svg className="gedges" width={L.width} height={L.height}>
              <defs><marker id="garr" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0 10 5 0 10z" style={{ fill: 'var(--accent)' }} /></marker>
                <marker id="gmarr" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0 10 5 0 10z" style={{ fill: 'var(--st-review)' }} /></marker>
                <marker id="glarr" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0 10 5 0 10z" style={{ fill: 'var(--st-stopped)' }} /></marker>
                <marker id="grarr" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 10 5 0 10z" style={{ fill: 'var(--dim)' }} /></marker></defs>
              {L.edges.map((e, i) => {
                const a = L.nodes.get(e.a), b = L.nodes.get(e.b); if (!a || !b) return null;
                const both = e.kind === 'message' && L.edges.some(x => x.kind === 'message' && x.a === e.b && x.b === e.a);
                const g = edgePath(a, b, e.kind, both), cls = `gedge ${e.kind} ${e.pending ? 'pending' : ''} ${chain?.eset.has(i) ? 'hl' : ''}`;
                if (e.kind === 'link') {
                  const what = e.lk === 'dependsOn' ? `${nodeName(e.b)} depends on ${nodeName(e.a)}${e.open ? '' : ' (done)'}` : e.lk === 'replaces' ? `${nodeName(e.a)} is ${e.folded ? 'folded into' : 'replaced by'} ${nodeName(e.b)}` : e.lk === 'followUpOf' ? `${nodeName(e.b)} is a follow-up of ${nodeName(e.a)}` : `${nodeName(e.a)} is related to ${nodeName(e.b)}`;
                  return <g key={i} className={`gclick ${chain?.eset.has(i) ? 'hl' : ''}`} onClick={() => open(e.owner!)}>
                    <title>{`${what}${e.note ? `: “${e.note}”` : ''}. Click to open the task that holds the link.`}</title>
                    <path className={`${cls} ${e.lk} ${e.open ? 'open' : ''}`} d={g.d} markerEnd={e.lk === 'dependsOn' && e.open ? 'url(#glarr)' : e.lk === 'replaces' ? 'url(#grarr)' : undefined} /><path className="ghit" d={g.d} />
                  </g>;
                }
                if (e.kind !== 'message') return <path key={i} className={cls} d={g.d} markerEnd={e.kind === 'handoff' ? 'url(#garr)' : undefined} />;
                const n = e.ids!.length;
                // the wide transparent path and the count take the click; the tooltip has no message text
                return <g key={i} className={`gclick ${chain?.eset.has(i) ? 'hl' : ''}`} onClick={() => setPanel({ a: e.a, b: e.b })}>
                  <title>{`${n} message${n === 1 ? '' : 's'} from ${nodeName(e.a)} to ${nodeName(e.b)}${e.pending ? ', not sent yet' : ''}. Last: ${new Date(e.last!).toLocaleString()}`}</title>
                  <path className={cls} d={g.d} markerEnd="url(#gmarr)" /><path className="ghit" d={g.d} />
                  <g className="gcount"><rect x={g.mx - 11} y={g.my - 9} width={22} height={18} rx={9} /><text x={g.mx} y={g.my + 4}>{n}</text></g>
                </g>;
              })}
            </svg>
            {nodes.map(n => <NodeCard key={n.id} n={n} groups={groups} mode={mode} sel={sel === n.id} hl={!!chain?.set.has(n.id)}
              onEnter={() => setHover(n.id)} onLeave={() => setHover(null)} onClick={() => { select(n.id); openNode(n.id); }} />)}
          </div>}
      </div>
      {panelView}
    </div>
  );
}

function NodeCard({ n, groups, mode, sel, hl, onEnter, onLeave, onClick }: { n: GNode; groups: Group[]; mode: LaneMode; sel: boolean; hl: boolean; onEnter: () => void; onLeave: () => void; onClick: () => void }) {
  const style = { left: n.x, top: n.y, width: n.w, height: n.h } as React.CSSProperties;
  const cls = `${sel ? 'sel' : ''} ${hl ? 'hl' : ''}`;
  if (n.kind === 'more') {
    return <button type="button" className={`gnode more ${cls}`} style={style} aria-expanded={n.expanded}
      aria-label={`${n.expanded ? 'Collapse' : 'Expand'} ${n.extraDocs} older files for task ${n.owner}`}
      onPointerEnter={onEnter} onPointerLeave={onLeave} onClick={onClick}>
      <strong>{n.expanded ? 'Show latest 3' : `+${n.extraDocs} more files`}</strong>
      <span>{n.expanded ? 'Collapse older files' : 'Expand all files'}</span>
    </button>;
  }
  if (n.kind === 'person' || n.kind === 'source') {
    const p = n.person, st = n.stats;
    const name = p ? p.name : SOURCES[n.src!];
    const counts = [st!.sent && `${st!.sent} sent`, st!.unsent && `${st!.unsent} not sent`, st!.received && `${st!.received} in`, st!.unrouted && `${st!.unrouted} not routed`].filter(Boolean).join(' · ');
    return (
      <div className={`gnode ${n.kind} ${cls}`} style={style} title={`${name}${p ? ` (${p.user})` : ''} · ${[st!.sent && `${st!.sent} sent`, st!.unsent && `${st!.unsent} not sent`, st!.received && `${st!.received} received`, st!.unrouted && `${st!.unrouted} not routed`].filter(Boolean).join(' · ')}${st?.last ? ` · last ${new Date(st.last).toLocaleString()}` : ''}`} onPointerEnter={onEnter} onPointerLeave={onLeave} onClick={onClick}>
        {p ? <Face person={p} /> : <span className="gface src" aria-hidden="true">{name[0]}</span>}
        <div className="pn">{name}</div><div className="pc">{counts}</div>
      </div>
    );
  }
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
      <div className="r1"><Dot s={t.status} /><span className="num">#{t.num}</span>{attn && <span className="wait">waiting {fmtWait(t.waitMin)}</span>}<span className="ag">{t.agent === 'claude' ? 'Claude' : AGENT_NAME[t.agent]}</span></div>
      <div className={`ti ${t.link?.state === 'superseded' ? 'lk-strike' : ''}`}>{t.title}</div>
      <div className="ln">{t.link?.state === 'blocked' ? <><b className="lk-blk">Blocked</b> {line}</> : line}</div>
      <div className="ft">
        {shown.map(g => <i key={g.id} style={{ background: g.color }} title={g.name} />)}
        {mode === 'group' && others.length > 0 ? <span className="also">also in {others.map(g => g.name).join(', ')}</span> : <span>{mode === 'folder' ? (t.branch || '') : folderOf(t)}</span>}
        {io > 0 && <span className="io">in {t.docs?.inbox || 0} · out {t.docs?.outbox || 0}</span>}
      </div>
    </div>
  );
}
