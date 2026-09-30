import { useState } from 'react';
import { hasFiles, uploadAll } from '../drop';
import type { Group, Task } from '../api';
import { ATTN, ORDER, STATUS_LABEL, api, fmtWait, shortPath } from '../api';
import { AgentChip, ByController, Dot, Kbd, MachineChip, ThreeLines, WhereChip } from './ui';
import { planGroupDrop, planUngroup, type DropPlan } from '../groupMove';
import { runGroupChange, type Toast } from '../groupActions';

const sortTasks = (s: string) => (a: Task, b: Task) => ATTN.includes(s as Task['status']) ? b.waitMin - a.waitMin : Date.parse(b.updated) - Date.parse(a.updated);
const GroupDots = ({ t, groups }: { t: Task; groups: Group[] }) => { const gs = groups.filter(g => g.tasks.includes(t.id)); return gs.length ? <span className="gdots" title={gs.map(g => g.name).join(', ')}>{gs.map(g => <i key={g.id} style={{ background: g.color }} />)}</span> : null; };

export function ListView({ tasks, groups, open, showArchived, selected, toggleSel }: { tasks: Task[]; groups: Group[]; open: (id: string) => void; showArchived: boolean; selected: Set<string>; toggleSel: (id: string) => void }) {
  const groupsByStatus = ORDER.filter(s => showArchived || s !== 'archived').map(s => [s, tasks.filter(t => t.status === s).sort(sortTasks(s))] as const).filter(([, l]) => l.length);
  if (!tasks.length) return <Empty />;
  return (
    <div className="lst">
      {groupsByStatus.map(([s, list]) => (
        <div className="grp" key={s}>
          <h3><Dot s={s} />{STATUS_LABEL[s]}<span className="c">{list.length}</span></h3>
          <div className="tb"><table><colgroup><col style={{ width: 34 }} /><col style={{ width: '26%' }} /><col style={{ width: 112 }} /><col style={{ width: '18%' }} /><col /><col style={{ width: 92 }} /></colgroup><tbody>
            {list.map(t => (
              <tr className={`r ${selected.has(t.id) ? 'selected' : ''}`} key={t.id} onClick={e => { if ((e.target as HTMLElement).closest('input')) return; if (e.metaKey || e.shiftKey) toggleSel(t.id); else open(t.id); }}>
                <td><input type="checkbox" className="selbox" checked={selected.has(t.id)} onChange={() => toggleSel(t.id)} title="Select, then group these or open them together in a new window" /></td>
                <td className="title"><Dot s={t.status} /> <span className="n">#{t.num}</span>{t.title} <GroupDots t={t} groups={groups} /></td>
                <td><AgentChip a={t.agent} /></td>
                <td className="mono"><MachineChip t={t} /><WhereChip t={t} /> {shortPath(t.cwd)}</td>
                <td className="last"><ThreeLines t={t} /></td>
                <td className="when">{ATTN.includes(t.status) ? <span className="waitchip">{fmtWait(t.waitMin)}</span> : fmtWait(Math.round((Date.now() - Date.parse(t.updated)) / 60000))}</td>
              </tr>
            ))}
          </tbody></table></div>
        </div>
      ))}
    </div>
  );
}

const COLS: [string, string, Task['status'][]][] = [
  ['needs-you', 'Needs you', ['needs-you', 'stopped', 'review']], ['working', 'Working', ['working']], ['unread', 'Done · unread', ['unread']],
  ['idle', 'Idle', ['idle']], ['suspended', 'Suspended', ['suspended']], ['parked', 'Set aside', ['parked']],
];
const MANUAL = ['idle', 'parked'];

export function BoardView({ tasks, groups, open, openDocs, selected, toggleSel, newGroup, toast }: { tasks: Task[]; groups: Group[]; open: (id: string) => void; openDocs: (id: string) => void; selected: Set<string>; toggleSel: (id: string) => void; newGroup: () => void; toast: Toast }) {
  const [by, setBy] = useState<'status' | 'groups'>(() => (localStorage.getItem('tb-board-by') as 'status' | 'groups') || 'status');
  const [over, setOver] = useState<{ key: string; refused?: string } | null>(null); // the column under a dragged card
  const [dragging, setDragging] = useState<{ id: string; from: string } | null>(null); // dragover events cannot read the dragged data
  const setMode = (m: 'status' | 'groups') => { setBy(m); localStorage.setItem('tb-board-by', m); };
  const live = tasks.filter(t => t.status !== 'archived');
  if (!tasks.length) return <Empty />;

  const card = (t: Task, from: string) => (
    <div className={`card ${t.status} ${selected.has(t.id) ? 'selected' : ''}`} key={t.id} draggable
      onDragStart={e => { e.dataTransfer.setData('text/plain', `${t.id}|${from}`); setDragging({ id: t.id, from }); }} onDragEnd={() => { setDragging(null); setOver(null); }}
      onDragOver={e => { if (hasFiles(e) && !t.machine) { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.add('filedrop'); } }}
      onDragLeave={e => e.currentTarget.classList.remove('filedrop')}
      onDrop={e => { if (!hasFiles(e) || t.machine) return; e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove('filedrop'); uploadAll(t.id, e.dataTransfer.files, toast); }}
      onClick={e => { if ((e.target as HTMLElement).closest('button')) return; if (e.metaKey || e.shiftKey) toggleSel(t.id); else open(t.id); }}>
      <div className="h"><Dot s={t.status} /><div className="ti">{t.title}</div><span className="n">#{t.num}</span></div>
      <div className="meta"><ByController t={t} /><AgentChip a={t.agent} /><MachineChip t={t} /><WhereChip t={t} /><span className="chip mono">{shortPath(t.cwd).replace('~/', '')}</span><GroupDots t={t} groups={groups} /></div>
      {['stopped', 'review'].includes(t.status) && <div className={`st-label ${t.status}`} style={{ marginTop: 6 }}>{STATUS_LABEL[t.status]}</div>}
      <ThreeLines t={t} />
      <div className="foot"><span className="sp" /><span className="io" onClick={e => { e.stopPropagation(); openDocs(t.id); }} title="Inbox and outbox">in {t.docs?.inbox || 0} · out {t.docs?.outbox || 0}</span></div>
      {from.startsWith('g:') && <button className="rm" onClick={() => { const p = planUngroup(t.id, t.num, groups, from.slice(2)); if ('change' in p) runGroupChange(p.change, toast); }} title={`Remove from ${groups.find(g => 'g:' + g.id === from)?.name}. The agent keeps running.`}>remove</button>}
    </div>
  );
  // Groups mode: a group column adds the card's task to that group (⌥ moves it from the card's column). The Ungrouped
  // column takes it out of the card's group column. groupMove.ts decides, and says why when a column refuses.
  const plan = (col: string, id: string, from: string, alt: boolean): DropPlan => {
    const num = tasks.find(t => t.id === id)?.num ?? '?', fromGroup = from.startsWith('g:') ? from.slice(2) : undefined;
    return col === 'none' ? planUngroup(id, num, groups, fromGroup) : planGroupDrop(id, num, groups, col.slice(2), fromGroup, alt);
  };
  const drop = (col: string) => async (e: React.DragEvent) => {
    e.preventDefault(); setOver(null); setDragging(null);
    const [id, from] = e.dataTransfer.getData('text/plain').split('|'); if (!id || col === from) return;
    if (by === 'status') {
      if (!MANUAL.includes(col)) { toast('That column is set by the agents themselves. You can drag cards into Idle or Parked.'); return; }
      await api.setStatus(id, col);
    } else {
      const p = plan(col, id, from, e.altKey);
      if ('change' in p) runGroupChange(p.change, toast); else toast(p.refused + '.');
    }
  };
  const dragOver = (k: string) => (e: React.DragEvent) => {
    if (by === 'groups' && dragging && !hasFiles(e)) {
      if (k === dragging.from) { setOver(null); return; } // the card's own column: no drop and no warning
      const p = plan(k, dragging.id, dragging.from, e.altKey);
      if ('refused' in p) { e.dataTransfer.dropEffect = 'none'; setOver(o => o?.key === k && o.refused === p.refused ? o : { key: k, refused: p.refused }); return; }
      e.dataTransfer.dropEffect = e.altKey ? 'move' : 'copy';
    }
    e.preventDefault(); setOver(o => o?.key === k && !o.refused ? o : { key: k });
  };
  const colProps = (k: string) => ({
    className: `col ${over?.key === k ? (over.refused ? 'nodrop' : 'drop') : ''}`, title: over?.key === k && over.refused ? `Cannot drop here: ${over.refused}.` : undefined,
    onDragOver: dragOver(k), onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null); }, onDrop: drop(k),
  });

  return (
    <div className="boardwrap">
      <div className="boardbar"><span className="lbl">Columns</span><div className="seg"><button className={by === 'status' ? 'on' : ''} onClick={() => setMode('status')}>Status</button><button className={by === 'groups' ? 'on' : ''} onClick={() => setMode('groups')}>Groups</button></div>
        <span className="lbl">{by === 'groups' ? 'Drag a card onto a group to add it; hold ⌥ to move it. Drag it onto Ungrouped to take it out of its group. ⌘-click to select several.' : 'Agents move cards between Needs you, Working and Done. You can drag into Idle and Parked.'}</span></div>
      <div className="cols">
        {by === 'status' ? COLS.map(([k, label, sts]) => {
          const list = tasks.filter(t => sts.includes(t.status)).sort(sortTasks(k));
          return <div key={k} {...colProps(k)}><h3><Dot s={k as Task['status']} />{label}<span className="c">{list.length}</span></h3><div className="cards">{list.map(t => card(t, k))}</div></div>;
        }) : <>
          {groups.map(g => {
            const list = g.tasks.map(id => live.find(t => t.id === id)).filter(Boolean) as Task[];
            return <div key={g.id} {...colProps('g:' + g.id)}><h3 style={{ borderBottom: `2px solid ${g.color}` }}><span className="dot" style={{ background: g.color, borderRadius: 3 }} />{g.name}<span className="c">{list.length}</span></h3><div className="cards">{list.sort(sortTasks('')).map(t => card(t, 'g:' + g.id))}</div></div>;
          })}
          {(() => { const none = live.filter(t => !groups.some(g => g.tasks.includes(t.id))); return <div {...colProps('none')}><h3><span className="dot idle" />Ungrouped<span className="c">{none.length}</span></h3><div className="cards">{none.map(t => card(t, 'none'))}</div></div>; })()}
          <div className="col newcol" onClick={newGroup}>＋ New group</div>
        </>}
      </div>
    </div>
  );
}

export function Empty() {
  return <div className="emptyview"><h2>No tasks yet</h2><p>Press <Kbd id="newTask" /> to start an agent in a folder, or use <b>⇪ Import sessions</b> in the sidebar to bring in Claude Code, Codex and Antigravity sessions you already have. Each agent runs in its own tmux session, and its status shows up here from Claude Code's hooks or Codex's notify program.</p></div>;
}
