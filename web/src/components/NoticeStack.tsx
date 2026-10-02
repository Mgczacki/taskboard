// The notification stack at the top right of the dashboard: approval cards and question cards, one at a time, oldest
// first (first in, first out). A new card joins the back, so the front card never changes under the pointer. When the
// front card changes, its buttons stay off for 0.6 s, so a second click meant for the old card cannot answer the new one.
import { useEffect, useRef, useState } from 'react';
import type { Approval, PendingItem, Task } from '../api';
import { ApprovalCard } from './ApprovalCard';
import { PendingCard } from './PendingCard';

type Entry = { id: string; at: string; approval?: Approval; item?: PendingItem };
const GUARD_MS = 600;

export function NoticeStack({ approvals, pending, allTasks, setOpenId, openController, toast, showAll }: {
  approvals: Approval[]; pending: PendingItem[]; allTasks: Task[]; setOpenId: (id: string) => void; openController: () => void; toast: (s: string) => void; showAll: () => void;
}) {
  const entries: Entry[] = [
    ...approvals.map(a => ({ id: `a:${a.id}`, at: a.created, approval: a })),
    ...pending.map(i => ({ id: `p:${i.id}`, at: i.createdAt, item: i })),
  ].sort((x, y) => x.at.localeCompare(y.at));
  const [frontId, setFrontId] = useState<string | null>(null);
  const [hidden, setHidden] = useState(() => { try { return sessionStorage.getItem('tb-stack-hidden') === '1'; } catch { return false; } });
  const [guard, setGuard] = useState(false);
  const index = Math.max(0, entries.findIndex(e => e.id === frontId));
  const front = entries[index];
  const shown = useRef<string | undefined>(undefined);
  // keep the front card when others arrive; move on to the next oldest when it closes
  useEffect(() => {
    if (!front) return;
    if (front.id !== frontId) setFrontId(front.id);
    if (shown.current && shown.current !== front.id) { setGuard(true); const t = setTimeout(() => setGuard(false), GUARD_MS); shown.current = front.id; return () => clearTimeout(t); }
    shown.current = front.id;
  }, [front?.id]);
  const hide = (h: boolean) => { setHidden(h); try { sessionStorage.setItem('tb-stack-hidden', h ? '1' : '0'); } catch { /* storage off */ } };
  if (!entries.length) return null;
  if (hidden) return <button className="btn ns-pill" onClick={() => hide(false)} title="Show the cards that wait on you, oldest first">{entries.length} waiting on you</button>;
  const go = (d: number) => setFrontId(entries[(index + d + entries.length) % entries.length].id);
  return <div className="ns" role="region" aria-label="Cards that wait on you">
    <div className="ns-bar"><b>{index + 1} of {entries.length}</b><span className="sub">oldest first</span><span className="pc-sp" />
      <button className="btn ghost" disabled={entries.length < 2} onClick={() => go(-1)}>Previous</button>
      <button className="btn ghost" disabled={entries.length < 2} onClick={() => go(1)}>Next</button>
      <button className="btn ghost" onClick={showAll} title="The Waiting page: everything that waits on you">All</button>
      <button className="btn ghost" onClick={() => hide(true)}>Hide</button>
    </div>
    <div className={`ns-front ${guard ? 'guard' : ''}`}>
      {front.approval && <ApprovalCard key={front.id} a={front.approval} allTasks={allTasks} setOpenId={setOpenId} openController={openController} toast={toast} />}
      {front.item && <PendingCard key={front.id} item={front.item} compact openTask={setOpenId} toast={toast} />}
    </div>
    {entries.length > 1 && <div className="ns-edge" />}{entries.length > 2 && <div className="ns-edge two" />}
  </div>;
}
