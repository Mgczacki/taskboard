// The notice strip of the task panel: one notice of the task at a time, on one row, with Previous and Next and a count
// ("1 of 3"), most urgent first (taskNotices.ts). It works like the notice stack at the top right of the dashboard
// (NoticeStack.tsx), for the notices of one task: failed and queued messages, question and approval cards, a stopped
// agent, a failed restart, a failed panel action, and information notes. Each row has a title, a one-line reason, a
// "more" control for the whole text, and the buttons of the notice. An information note hides itself after
// AUTO_HIDE_MS or at the next click outside the strip; the LOG tab keeps it (noticeHistory).
// Hide on a note only hides it in this panel. It does not change what the task was told (task 274).
import { useEffect, useRef, useState } from 'react';
import type { QueuedMessage, Task } from '../api';
import { api } from '../api';
import { showInStack } from '../stack';
import { dismissItem, DISMISS_TITLE, HOOK_TITLE, holdsHook } from '../dismiss';
import type { PendingItem } from '../api';
import { KIND_LABEL } from './PendingCard';
import { AUTO_HIDE_MS, hideInfo, infoHidden, LEVEL_WORD, rememberNotice, stripIndex, type TaskNotice } from '../taskNotices';

export interface NoticeAction { label: string; title: string; run: () => unknown; primary?: boolean }
export interface ActionContext {
  t: Pick<Task, 'id' | 'num' | 'queue'>;
  pending?: PendingItem[];
  act: (p: Promise<unknown>) => Promise<unknown>;
  toast: (s: string) => void;
  clearError: () => void; clearDrop: () => void; hide: (key: string) => void;
  moveAccount?: () => void; // the Move account panel (not for the controller)
  resumeAnyway?: () => void; // the error "Still open ..." can resume here anyway
}

const each = (ids: string[], f: (id: string) => Promise<unknown>) => Promise.all(ids.map(f));
const them = (n: number, one: string, many: string) => n === 1 ? one : many.replace('#', String(n));

// The buttons of one notice. Grouped messages: each button acts on every message of the group, oldest first.
export function noticeActions(n: TaskNotice, c: ActionContext): NoticeAction[] {
  const { t, act } = c;
  if (n.kind === 'message') {
    const qs = n.ids.map(id => t.queue?.find(q => q.id === id)).filter(Boolean) as QueuedMessage[];
    const out: NoticeAction[] = [];
    const byHook = qs.filter(q => q.hook && q.via !== 'hook');
    if (byHook.length) out.push({ label: 'Deliver by hook', title: `Give ${them(byHook.length, 'the message', 'the # messages')} to the agent when ${byHook[0].hook}. Taskboard stops typing ${them(byHook.length, 'it', 'them')}.`, run: () => act(each(byHook.map(q => q.id), id => api.queueAction(t.id, id, 'hook'))) });
    const failed = qs.filter(q => q.state === 'failed');
    if (failed.length) out.push({ label: 'Type again', title: `Wait for an empty input box again, then type ${them(failed.length, 'the message', 'the # messages')}`, run: () => act(each(failed.map(q => q.id), id => api.queueAction(t.id, id, 'retry'))) });
    else if (qs.length) out.push({ label: 'Type now', title: 'Try to type the first message now. Nothing is typed when the box holds text or a question shows.', run: async () => {
      const r = await act(api.queueAction(t.id, qs[0].id, 'type')) as { state?: string; reason?: string } | undefined;
      if (r?.state) c.toast(r.state === 'delivered' ? `Typed into #${t.num}.` : `Not typed: ${r.reason}`);
    } });
    if (qs.length) out.push({ label: 'Remove', title: `Remove ${them(qs.length, 'the message', 'the # messages')}. ${them(qs.length, 'It is', 'They are')} not delivered, and a sender task is told.`, run: () => act(each(qs.map(q => q.id), id => api.queueAction(t.id, id, 'remove'))) });
    return out;
  }
  if (n.kind === 'question') {
    const first = c.pending?.find(p => p.id === n.ids[0]);
    return [
      { label: 'Answer', title: 'Open the card in the notification stack', primary: true, run: () => showInStack(t.id) },
      ...(first ? [{ label: 'Dismiss', title: holdsHook(first) ? HOOK_TITLE : DISMISS_TITLE, run: () => dismissItem(first, KIND_LABEL[first.kind], c.toast) }] : []),
    ];
  }
  if (n.kind === 'card') return [{ label: 'Open card', title: 'Open the card in the notification stack', primary: true, run: () => showInStack(`a:${n.ids[0]}`) }];
  if (n.kind === 'stopped') return [
    { label: 'Retry now', title: 'Type "continue" into the agent', primary: true, run: () => act(api.send(t.id, 'continue')) },
    ...(c.moveAccount ? [{ label: 'Move account…', title: 'Continue the task with another account', run: c.moveAccount }] : []),
    { label: 'Accounts…', title: 'The Accounts page', run: () => { location.hash = 'accounts'; } },
  ];
  if (n.kind === 'restart-failed') return [{ label: 'Try again', title: 'Start the agent again', run: () => act(api.resume(t.id)) }];
  if (n.kind === 'resumed') return [{ label: 'Continue', title: 'Type "continue where you left off" into the agent', run: () => act(api.send(t.id, 'continue where you left off')) }];
  if (n.kind === 'error') return [
    ...(n.full.startsWith('Still open') && c.resumeAnyway ? [{ label: 'Resume here anyway', title: 'Only if you are sure the other terminal is not using this conversation', run: c.resumeAnyway }] : []),
    { label: 'Hide', title: 'Hide this error. Nothing is sent to the task.', run: c.clearError },
  ];
  if (n.kind === 'drop') return [{ label: 'Hide', title: 'Hide this note. Nothing is sent to the task.', run: () => { c.clearDrop(); c.hide(n.key); } }];
  if (n.autoHide) return [{ label: 'Hide', title: 'Hide this note. The LOG tab keeps it. Nothing is sent to the task.', run: () => c.hide(n.key) }];
  return [];
}

// The strip without state, for the tests: the shown notice, its index and the handlers
export function NoticeStripView({ list, index, more, go, setMore, actions, id }: { list: TaskNotice[]; index: number; more: boolean; go: (d: 1 | -1) => void; setMore: (m: boolean) => void; actions: NoticeAction[]; id: string }) {
  if (!list.length) return null;
  const n = list[index];
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest?.('input, textarea, select')) return;
    if (e.key === 'ArrowLeft' && list.length > 1) { e.preventDefault(); go(-1); }
    else if (e.key === 'ArrowRight' && list.length > 1) { e.preventDefault(); go(1); }
    else if (e.key === 'Escape' && more) { e.preventDefault(); e.stopPropagation(); setMore(false); }
  };
  return <div className={`ns-strip lv-${n.level}`} role="region" aria-label="Notices of this task" onKeyDown={onKey}>
    <div className="nss-row">
      <span className={`nss-dot lv-${n.level}`} title={LEVEL_WORD[n.level]} aria-label={LEVEL_WORD[n.level]} />
      {list.length > 1 && <span className="nss-nav">
        <button className="btn ghost icon" onClick={() => go(-1)} aria-label="Previous notice" title="Previous notice (←)">‹</button>
        <span className="nss-n" title="Most urgent first: errors, then warnings, then information. Oldest first within each.">{index + 1} of {list.length}</span>
        <button className="btn ghost icon" onClick={() => go(1)} aria-label="Next notice" title="Next notice (→)">›</button>
      </span>}
      <span className="nss-text" aria-live="polite"><b>{n.title}</b><span className="nss-why">{n.reason}</span></span>
      <button className="btn ghost nss-more" aria-expanded={more} aria-controls={`${id}-full`} onClick={() => setMore(!more)}>{more ? 'less' : 'more'}</button>
      {actions.map(a => <button key={a.label} className={`btn ${a.primary ? '' : 'ghost'} nss-act`} title={a.title} onClick={() => void a.run()}>{a.label}</button>)}
    </div>
    {more && <div className="nss-full" id={`${id}-full`}>{n.full}</div>}
  </div>;
}

export function NoticeStrip({ list: all, ctx }: { list: TaskNotice[]; ctx: Omit<ActionContext, 'hide'> }) {
  const taskId = ctx.t.id;
  const [, redraw] = useState(0);
  const hide = (keys: string[]) => { hideInfo(taskId, keys); redraw(x => x + 1); };
  const list = all.filter(n => !infoHidden(taskId, n.key));
  const [key, setKey] = useState<string | null>(null);
  const last = useRef(0);
  const index = stripIndex(list, key, last.current);
  last.current = index;
  const [more, setMore] = useState(false);
  const n = list[index];
  useEffect(() => { setMore(false); }, [n?.key]);
  // the LOG tab lists every notice that the strip had
  for (const x of list) rememberNotice(taskId, x);
  // information notes: hide after AUTO_HIDE_MS, or at the next click outside the strip
  const infoKeys = list.filter(x => x.autoHide).map(x => x.key);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!infoKeys.length) return;
    const timer = setTimeout(() => hide(infoKeys), AUTO_HIDE_MS);
    const down = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) hide(infoKeys); };
    // the listener starts after this render, so the click that made the note does not hide it
    const on = setTimeout(() => addEventListener('pointerdown', down, true), 0);
    return () => { clearTimeout(timer); clearTimeout(on); removeEventListener('pointerdown', down, true); };
  }, [infoKeys.join('\n')]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!n) return null;
  const go = (d: 1 | -1) => setKey(list[(index + d + list.length) % list.length].key);
  return <div ref={box}><NoticeStripView list={list} index={index} more={more} setMore={setMore} go={go} id={`nss-${taskId}`}
    actions={noticeActions(n, { ...ctx, hide: k => hide([k]) })} /></div>;
}
