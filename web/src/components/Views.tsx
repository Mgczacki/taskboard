import { useState } from 'react';
import { hasFiles, uploadAll } from '../drop';
import type { Group, Task } from '../api';
import { ATTN, ORDER, STATUS_LABEL, api, fmtWait, shortPath } from '../api';
import { ManagerBadge } from './ManagerBoard';
import { AgentChip, ByController, Dot, Kbd, MachineChip, ThreeLines, WhereChip, BrowserAskChip } from './ui';
import { planGroupDrop, planUngroup, type DropPlan } from '../groupMove';
import { runGroupChange, type Toast } from '../groupActions';
import { LinkMarker, LinkState } from './Links';
import { isReplaced, linkedSets, linkOrder, setLead, treeDepth } from '../links';

const sortTasks = (s: string) => (a: Task, b: Task) => ATTN.includes(s as Task['status']) ? b.waitMin - a.waitMin : Date.parse(b.updated) - Date.parse(a.updated);
const GroupDots = ({ t, groups }: { t: Task; groups: Group[] }) => { const gs = groups.filter(g => g.tasks.includes(t.id)); return gs.length ? <span className="gdots" title={gs.map(g => g.name).join(', ')}>{gs.map(g => <i key={g.id} style={{ background: g.color }} />)}</span> : null; };

// List options, saved in the browser: sections by status or by linked set, indentation in linked sets, replaced tasks.
const pref = <T extends string>(k: string, d: T, ok: T[]): T => { try { const v = localStorage.getItem(k) as T; return ok.includes(v) ? v : d; } catch { return d; } };
const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage off */ } };

export function ListView({ tasks, groups, open, showArchived, selected, toggleSel }: { tasks: Task[]; groups: Group[]; open: (id: string) => void; showArchived: boolean; selected: Set<string>; toggleSel: (id: string) => void }) {
  const [by, setBy] = useState(() => pref<'status' | 'sets'>('tb-list-by', 'status', ['status', 'sets']));
  const [indent, setIndent] = useState(() => pref<'deps' | 'parent'>('tb-list-indent', 'deps', ['deps', 'parent']));
  const [hideReplaced, setHideReplaced] = useState(() => pref<'1' | '0'>('tb-list-hide-replaced', '1', ['1', '0']) === '1');
  const shown = tasks.filter(t => (showArchived || t.status !== 'archived') && !(hideReplaced && isReplaced(t)));
  const replacedCount = tasks.filter(t => (showArchived || t.status !== 'archived') && isReplaced(t)).length;
  const groupsByStatus = ORDER.filter(s => showArchived || s !== 'archived').map(s => [s, shown.filter(t => t.status === s).sort(sortTasks(s))] as const).filter(([, l]) => l.length);
  if (!tasks.length) return <Empty />;
  const anyLinks = tasks.some(t => t.link || (t.parent && t.parent !== 'controller'));
  const sets = by === 'sets' ? linkedSets(shown).map(l => treeDepth(linkOrder(l.sort((a, b) => a.num - b.num), tasks), tasks, indent)) : [];
  const inSets = new Set(sets.flat().map(x => x.t.id));
  const row = (t: Task, depth = 0, also: string[] = []) => (
              <tr className={`r ${selected.has(t.id) ? 'selected' : ''}`} key={t.id} onClick={e => { if ((e.target as HTMLElement).closest('input')) return; if (e.metaKey || e.shiftKey) toggleSel(t.id); else open(t.id); }}>
                <td><input type="checkbox" className="selbox" checked={selected.has(t.id)} onChange={() => toggleSel(t.id)} title="Select, then group these or open them together in a new window" /></td>
                <td className="title" style={depth ? { paddingLeft: 8 + depth * 18 } : undefined}>{depth > 0 && <span className="lk-indent">└ </span>}<LinkMarker t={t} tasks={tasks} /> <Dot s={t.status} /> <span className="n">#{t.num}</span><span className={isReplaced(t) ? 'lk-strike' : ''}>{t.title}</span> <ManagerBadge id={t.id} /> <GroupDots t={t} groups={groups} />{also.length > 0 && <span className="lk-st">also #{also.map(id => tasks.find(x => x.id === id)?.num).join(' #')}</span>}</td>
                <td><AgentChip a={t.agent} /></td>
                <td className="mono"><MachineChip t={t} /><WhereChip t={t} /><BrowserAskChip t={t} /> {shortPath(t.cwd)}</td>
                <td className="last">{by === 'sets' && <div style={{ marginBottom: 2 }}><LinkState t={t} tasks={tasks} /></div>}<ThreeLines t={t} /></td>
                <td className="when">{ATTN.includes(t.status) ? <span className="waitchip">{fmtWait(t.waitMin)}</span> : fmtWait(Math.round((Date.now() - Date.parse(t.updated)) / 60000))}</td>
              </tr>);
  const table = (rows: React.ReactNode) => <div className="tb"><table><colgroup><col style={{ width: 34 }} /><col style={{ width: '26%' }} /><col style={{ width: 112 }} /><col style={{ width: '18%' }} /><col /><col style={{ width: 92 }} /></colgroup><tbody>{rows}</tbody></table></div>;
  return (
    <div className="lst">
      {anyLinks && <div className="lst-bar">
        <span>Sections</span><div className="seg"><button className={by === 'status' ? 'on' : ''} onClick={() => { setBy('status'); save('tb-list-by', 'status'); }}>Status</button><button className={by === 'sets' ? 'on' : ''} onClick={() => { setBy('sets'); save('tb-list-by', 'sets'); }} title="One section for each set of linked tasks">Linked sets</button></div>
        {by === 'sets' && <><span>Indent by</span><div className="seg"><button className={indent === 'deps' ? 'on' : ''} onClick={() => { setIndent('deps'); save('tb-list-indent', 'deps'); }} title="A task under the task it waits for">Depends on</button><button className={indent === 'parent' ? 'on' : ''} onClick={() => { setIndent('parent'); save('tb-list-indent', 'parent'); }} title="A task under the task that started it">Started by</button></div></>}
        <label><input type="checkbox" checked={hideReplaced} onChange={e => { setHideReplaced(e.target.checked); save('tb-list-hide-replaced', e.target.checked ? '1' : '0'); }} /> Hide replaced{replacedCount ? ` (${replacedCount})` : ''}</label>
      </div>}
      {by === 'sets' && <>
        {sets.map(set => <div className="grp" key={set[0].t.id}>
          <h3>Linked set of #{setLead(set.map(x => x.t)).num}<span className="c">{set.length}</span></h3>
          {table(set.map(x => row(x.t, x.depth, x.also)))}
        </div>)}
        {(rest => rest.length > 0 && <div className="grp"><h3>No links<span className="c">{rest.length}</span></h3>{table(rest.map(t => row(t)))}</div>)(shown.filter(t => !inSets.has(t.id)).sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || b.num - a.num))}
      </>}
      {by === 'status' && groupsByStatus.map(([s, list]) => (
        <div className="grp" key={s}>
          <h3><Dot s={s} />{STATUS_LABEL[s]}<span className="c">{list.length}</span></h3>
          <div className="tb"><table><colgroup><col style={{ width: 34 }} /><col style={{ width: '26%' }} /><col style={{ width: 112 }} /><col style={{ width: '18%' }} /><col /><col style={{ width: 92 }} /></colgroup><tbody>
            {list.map(t => row(t))}
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
      <div className="h"><Dot s={t.status} /><div className={`ti ${isReplaced(t) ? 'lk-strike' : ''}`}>{t.title}</div><LinkMarker t={t} tasks={tasks} /><span className="n">#{t.num}</span></div>
      <div className="meta"><ManagerBadge id={t.id} /><ByController t={t} /><AgentChip a={t.agent} /><MachineChip t={t} /><WhereChip t={t} /><BrowserAskChip t={t} /><span className="chip mono">{shortPath(t.cwd).replace('~/', '')}</span><GroupDots t={t} groups={groups} /></div>
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
