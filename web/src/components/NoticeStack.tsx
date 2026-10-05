// The notification stack at the top right of the dashboard: approval cards and question cards, one at a time, oldest
// first (first in, first out). A new card joins the back, so the front card never changes under the pointer. When the
// front card changes, its buttons stay off for 0.6 s, so a second click meant for the old card cannot answer the new one.
// The stack is the only place outside the Waiting page that shows a question card in full. Canvas windows and the task
// panel show a one-line marker, and its button (showInStack in stack.ts) brings that task's card to the front here, also
// when the stack is hidden.
// A front card that closes without a decision (for example a permit that expired) stays in front, greyed and without
// buttons, for CLOSED_MS or until the next click (closedNotice in stack.ts). A closed card is never in the count.
// Hide shows a pill with the count instead of the stack, until a card arrives (arrivals in stack.ts: a new card, or a
// card that the server updated in place). Then the stack shows again by itself, with a short pulse, and its buttons
// stay off for GUARD_MS. When the pointer is on the pill, the pill stays (it does not change under the pointer): it
// pulses and shows the number of new cards, and the stack shows when the pointer leaves the pill.
// The stack shows approval cards and question cards. The Waiting page also lists tasks that wait without a card and
// messages that wait to be delivered. The pill and the All button say so.
import { useEffect, useRef, useState } from 'react';
import type { Approval, PendingItem, Task } from '../api';
import { useStore } from '../api';
import { arrivals, CLOSED_MS, closedNotice, entryForTask, frontAfterArrival, frontIndex, HIDDEN_KEY, readHidden, seenCards, SHOW_EVENT, stackEntries, type Seen, type StackEntry } from '../stack';
import { ApprovalCard } from './ApprovalCard';
import { PendingCard } from './PendingCard';

const GUARD_MS = 600;
const PULSE_MS = 1600;
const ALSO = 'The Waiting page (All) also lists tasks that wait on you without a card, and messages that wait to be delivered.';

export function NoticeStack({ approvals, pending, allTasks, setOpenId, openController, toast, showAll }: {
  approvals: Approval[]; pending: PendingItem[]; allTasks: Task[]; setOpenId: (id: string) => void; openController: () => void; toast: (s: string) => void; showAll: () => void;
}) {
  const entries = stackEntries(approvals, pending);
  const [frontId, setFrontId] = useState<string | null>(null);
  // the cards that the stack showed when the user clicked Hide, or null when the stack shows
  const [hiddenSeen, setHiddenSeen] = useState<Seen | null>(() => { try { return readHidden(sessionStorage.getItem(HIDDEN_KEY)); } catch { return null; } });
  const hidden = hiddenSeen !== null;
  const [guard, setGuard] = useState(false);
  const guardTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const startGuard = () => { setGuard(true); clearTimeout(guardTimer.current); guardTimer.current = setTimeout(() => setGuard(false), GUARD_MS); };
  const [pulse, setPulse] = useState(0);
  useEffect(() => { if (!pulse) return; const t = setTimeout(() => setPulse(0), PULSE_MS); return () => clearTimeout(t); }, [pulse]);
  // cards that arrived while the pointer was on the pill
  const [fresh, setFresh] = useState(0);
  const onPill = useRef(false);
  const frontTask = useRef<string | undefined>(undefined);
  const index = frontIndex(entries, frontId, frontTask.current);
  const front = entries[index];
  const shown = useRef<string | undefined>(undefined);
  // the closed front card: the full lists hold its final state
  const { approvals: allApprovals, answered, cardsLoaded } = useStore();
  const [closed, setClosed] = useState<{ id: string; title: string; state: string; text: string } | null>(null);
  const lastFront = useRef<StackEntry | undefined>(undefined);
  const ids = entries.map(e => e.id).join(',');
  useEffect(() => {
    const prev = lastFront.current;
    lastFront.current = front;
    if (!prev || hidden || entries.some(e => e.id === prev.id)) return;
    // a screen card that got a new id is the same question: no notice
    if (prev.item && entries.some(e => e.item?.taskId === prev.item!.taskId)) return;
    const n = closedNotice(prev, allApprovals, answered);
    if (n) setClosed({ id: prev.id, ...n });
  }, [ids, allApprovals, answered]);
  useEffect(() => {
    if (!closed) return;
    const end = () => setClosed(null);
    const t = setTimeout(end, CLOSED_MS);
    // the next click anywhere removes it; the listener starts after this render, so the click that caused it is over
    const on = setTimeout(() => addEventListener('pointerdown', end, { capture: true, once: true }), 0);
    return () => { clearTimeout(t); clearTimeout(on); removeEventListener('pointerdown', end, { capture: true }); };
  }, [closed?.id]);
  // keep the front card when others arrive; move on to the next oldest when it closes
  useEffect(() => {
    frontTask.current = front?.item?.taskId;
    if (!front) return;
    if (front.id !== frontId) setFrontId(front.id);
    if (shown.current && shown.current !== front.id) { startGuard(); shown.current = front.id; return; }
    shown.current = front.id;
  }, [front?.id]);
  const latest = useRef(entries); latest.current = entries;
  const hide = (h: boolean) => {
    const seen = h ? seenCards(latest.current) : null;
    setHiddenSeen(seen); setFresh(0);
    try { if (seen) sessionStorage.setItem(HIDDEN_KEY, JSON.stringify(seen)); else sessionStorage.removeItem(HIDDEN_KEY); } catch { /* storage off */ }
  };
  // show the stack again for arrived cards: the front card stays when it still waits, the buttons wait GUARD_MS
  const reopen = (arrived: StackEntry[]) => {
    setFrontId(f => frontAfterArrival(latest.current, f, arrived));
    hide(false); startGuard(); setPulse(n => n + 1);
  };
  // the cards of the last list, to see what arrived while the stack shows (it then pulses only)
  const lastSeen = useRef<Seen | null>(null);
  const seenKey = JSON.stringify(seenCards(entries));
  useEffect(() => {
    if (!cardsLoaded) return;
    const before = lastSeen.current;
    lastSeen.current = seenCards(entries);
    if (!hidden) { if (arrivals(before, entries).length) setPulse(n => n + 1); return; }
    const arrived = arrivals(hiddenSeen, entries);
    if (!arrived.length) { setFresh(0); return; }
    if (onPill.current) { setFresh(arrived.length); setPulse(n => n + 1); return; }
    reopen(arrived);
  }, [seenKey, cardsLoaded, hidden]);
  const leavePill = () => {
    onPill.current = false;
    const arrived = hiddenSeen ? arrivals(hiddenSeen, latest.current) : [];
    if (arrived.length) reopen(arrived);
  };
  // a marker button asks for the card of one task: show the stack, put that card in front, scroll it to its top
  const frontEl = useRef<HTMLDivElement>(null);
  const [scrollTo, setScrollTo] = useState(0);
  useEffect(() => {
    const on = (e: Event) => {
      const id = entryForTask(latest.current, (e as CustomEvent<string>).detail);
      hide(false);
      if (id) { setFrontId(id); setScrollTo(n => n + 1); }
    };
    window.addEventListener(SHOW_EVENT, on);
    return () => window.removeEventListener(SHOW_EVENT, on);
  }, []);
  useEffect(() => { if (scrollTo && frontEl.current) { frontEl.current.scrollTop = 0; frontEl.current.scrollIntoView({ block: 'nearest' }); } }, [scrollTo]);
  const closedCard = closed && <div className="pcard gone ns-closed" aria-live="polite"><div className="pc-h"><b>{closed.state}</b><span className="pc-sp" /><span className="pc-age">not waiting</span></div><p className="pc-q">{closed.title}</p><div className="pc-note info">{closed.text}</div></div>;
  if (!entries.length) return closedCard ? <div className="ns" role="region" aria-label="Cards that wait on you"><div className="ns-bar"><b>Nothing waits on you</b></div><div className="ns-front">{closedCard}</div></div> : null;
  if (hidden) return <button className={`btn ns-pill ${pulse ? 'ns-pulse' : ''}`} onClick={() => hide(false)} onPointerEnter={() => { onPill.current = true; }} onPointerLeave={leavePill}
    title={`Show the cards that wait on you, oldest first. The stack also shows again by itself when a card arrives. ${ALSO}`}>{entries.length} waiting on you{fresh ? ` · ${fresh} new` : ''}</button>;
  const go = (d: number) => setFrontId(entries[(index + d + entries.length) % entries.length].id);
  return <div className="ns" role="region" aria-label="Cards that wait on you">
    <div className={`ns-bar ${pulse ? 'ns-pulse' : ''}`}><b>{index + 1} of {entries.length}</b><span className="sub">oldest first</span><span className="pc-sp" />
      <button className="btn ghost" disabled={entries.length < 2} onClick={() => go(-1)}>Previous</button>
      <button className="btn ghost" disabled={entries.length < 2} onClick={() => go(1)}>Next</button>
      <button className="btn ghost" onClick={showAll} title={`The Waiting page: everything that waits on you. ${ALSO}`}>All</button>
      <button className="btn ghost" onClick={() => hide(true)} title="Hide the stack until a new or changed card arrives">Hide</button>
    </div>
    <div ref={frontEl} className={`ns-front ${guard ? 'guard' : ''}`}>
      {closedCard}
      {!closedCard && front.approval && <ApprovalCard key={front.id} a={front.approval} allTasks={allTasks} setOpenId={setOpenId} openController={openController} toast={toast} />}
      {!closedCard && front.item && <PendingCard key={front.id} item={front.item} compact openTask={setOpenId} toast={toast} />}
    </div>
    {entries.length > 1 && <div className="ns-edge" />}{entries.length > 2 && <div className="ns-edge two" />}
  </div>;
}
