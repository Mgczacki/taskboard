// What runs for a task: its browser and its processes (server/runtime-summary.ts).
// - RuntimeButton: a small count on the task page and on each Canvas window, for example "1 browser · 2 processes".
//   It reads the counts that the server pushes (the "runtime" event) and shows nothing when nothing runs. A click opens a
//   small panel with the items, their memory, and buttons for the Browser tab, the Processes tab and the pop-out.
// - RuntimeList: the items of a set of tasks with memory and a total. The group view uses it with one row for each item
//   of each task in the group, labeled with the owning task. It reads GET /api/runtime every 4 s, only while it is shown.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RuntimeItem, RuntimeList as RuntimeData, Task } from '../api';
import { api, useStore } from '../api';
import { Dot } from './ui';
import { popOutBrowser } from './TaskBrowser';
import { countText, mb, plural, totalText } from '../runtimeText';

export type RuntimeTab = 'browser' | 'procs';
const REFRESH_MS = 4000;

export const canRun = (t: Task) => !t.machine && t.role !== 'controller';

// Read the items of these tasks now and every 4 s while the component is shown.
function useRuntime(ids: string[]) {
  const [data, setData] = useState<RuntimeData | null>(null);
  const [err, setErr] = useState('');
  const key = ids.join(',');
  const load = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let live = true;
    load.current = () => api.runtime(ids).then(d => { if (live) { setData(d); setErr(''); } }).catch(e => { if (live) setErr(String((e as Error).message || e)); });
    void load.current();
    const timer = setInterval(() => void load.current(), REFRESH_MS);
    return () => { live = false; clearInterval(timer); };
  }, [key]);
  return { data, err, setErr, reload: () => load.current() };
}

const on = (i: RuntimeItem) => i.state === 'running' || i.state === 'starting';
const STATE_DOT: Record<string, string> = { running: 'unread', starting: 'working', exited: 'stopped', stopped: 'idle', suspended: 'suspended' };


export function RuntimeList({ tasks, showOwner, onOpen, pictures = false }: { tasks: Task[]; showOwner: boolean; onOpen: (taskId: string, tab: RuntimeTab) => void; pictures?: boolean }) {
  const local = tasks.filter(canRun);
  const { data, err, setErr, reload } = useRuntime(local.map(t => t.id));
  const [busy, setBusy] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => setTick(n => n + 1), [data]);
  const byId = new Map(local.map(t => [t.id, t]));
  const stop = async (i: RuntimeItem) => {
    const k = `${i.task}/${i.kind}/${i.name}`;
    setBusy(k);
    try {
      if (i.kind === 'browser') await api.browserAction(i.task, 'stop');
      else await api.procAction('tasks', i.task, i.name, 'stop');
      await reload();
    } catch (e) { setErr(String((e as Error).message || e)); }
    setBusy('');
  };
  const items = data?.items || [];
  return (
    <div className="rtl">
      {err && <div className="banner">{err} <button className="btn ghost" onClick={() => setErr('')}>OK</button></div>}
      {showOwner && data && <div className="rtl-total" title="Memory is the footprint of each item's processes, counted like Activity Monitor does. The server reads it at most every 15 s while this view is open.">{totalText(data.total)}</div>}
      {data && !items.length && <div className="sub rtl-none">No browsers or processes. {showOwner ? 'A task gets them when its agent uses its browser or runs tb run.' : 'The agent starts them with its browser tools or tb run.'}</div>}
      {!data && !err && <div className="sub rtl-none">Reading…</div>}
      {!!items.length && <table className="rtl-table">
        <thead><tr>{showOwner && <th>Task</th>}<th>Item</th><th>State</th><th>Port</th><th title="Footprint of the item's processes, counted like Activity Monitor does.">Memory</th><th /></tr></thead>
        <tbody>{items.map(i => {
          const t = byId.get(i.task);
          const k = `${i.task}/${i.kind}/${i.name}`;
          const tab: RuntimeTab = i.kind === 'browser' ? 'browser' : 'procs';
          return (
            <tr key={k} className="rtl-row" onClick={e => { if (!(e.target as HTMLElement).closest('button, a')) onOpen(i.task, tab); }} title={`Open #${t?.num ?? '?'} on its ${i.kind === 'browser' ? 'Browser' : 'Processes'} tab`}>
              {showOwner && <td className="rtl-task">{t && <Dot s={t.status} />}<span className="num">#{t?.num ?? '?'}</span><span className="ti">{t?.title}</span></td>}
              <td><div className="rtl-item">
                {pictures && i.kind === 'browser' && on(i) && <img className="rtl-shot" alt="" src={`/api/tasks/${encodeURIComponent(i.task)}/browser/shot?t=${tick}`} onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} onLoad={e => { (e.target as HTMLImageElement).style.visibility = 'visible'; }} />}
                <span className={`rtl-kind ${i.kind}`}>{i.kind === 'browser' ? 'browser' : 'process'}</span>
                <b>{i.kind === 'browser' ? (i.pages !== undefined ? plural(i.pages, 'page', 'pages') : 'Browser') : i.name}</b>
                {showOwner && i.kind === 'proc' && i.command && <span className="rtl-cmd" title={i.command}>{i.command}</span>}
                {!!i.agents && <span className="rtl-agent">agent connected</span>}
              </div></td>
              <td className="rtl-state"><span className={`dot ${STATE_DOT[i.state] || 'idle'}`} /> {i.state}</td>
              <td>{i.port && i.kind === 'proc' ? <a href={`http://localhost:${i.port}`} target="_blank" rel="noreferrer" title="Open in your own browser">{i.port}</a> : '—'}</td>
              <td className="rtl-mem">{on(i) ? mb(i.memMb) : '—'}</td>
              <td className="rtl-act">
                {showOwner && i.kind === 'browser' && t && <button className="btn" onClick={() => popOutBrowser(i.task, `#${t.num} ${t.title}`, '', on(i))} title="Show this browser in its own window">Pop out</button>}
                {on(i) && <button className="btn" disabled={busy === k} onClick={() => stop(i)} title={i.kind === 'browser' ? `Close the browser of #${t?.num}. Its pages open again at the next start.` : `Stop ${i.name} of #${t?.num}. Other items keep running.`}>Stop</button>}
              </td>
            </tr>
          );
        })}</tbody>
      </table>}
    </div>
  );
}

// The count on a task. Nothing is shown when nothing runs.
export function RuntimeButton({ t, onOpen, small = false }: { t: Task; onOpen: (tab: RuntimeTab) => void; small?: boolean }) {
  const c = useStore().runtime[t.id];
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const text = countText(c);
  if (!canRun(t) || !text) return null;
  return (
    <>
      <button ref={btn} className={`rtb ${small ? 'small' : ''} ${open ? 'on' : ''}`} onClick={e => { e.stopPropagation(); setOpen(o => !o); }} title={`${text} run for this task. Click to see them and their memory.`}>
        {!!c?.browser && <span className="rtb-n"><i className="rtb-ico b" />{small ? c.browser : plural(c.browser, 'browser', 'browsers')}</span>}
        {!!c?.procs && <span className="rtb-n"><i className="rtb-ico p" />{small ? c.procs : plural(c.procs, 'process', 'processes')}</span>}
      </button>
      {open && <RuntimePopover t={t} anchor={btn.current} close={() => setOpen(false)} onOpen={tab => { setOpen(false); onOpen(tab); }} />}
    </>
  );
}

function RuntimePopover({ t, anchor, close, onOpen }: { t: Task; anchor: HTMLElement | null; close: () => void; onOpen: (tab: RuntimeTab) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const r = anchor?.getBoundingClientRect();
  const width = Math.min(560, innerWidth - 24);
  const left = Math.max(12, Math.min((r?.left ?? 12), innerWidth - width - 12));
  const top = (r?.bottom ?? 40) + 6;
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node)) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    addEventListener('mousedown', down); addEventListener('keydown', esc);
    return () => { removeEventListener('mousedown', down); removeEventListener('keydown', esc); };
  }, [anchor]);
  return createPortal(
    <div ref={box} className="rtb-pop" style={{ left, top, width }} onPointerDown={e => e.stopPropagation()}>
      <div className="rtb-pop-h"><b>#{t.num} {t.title}</b><span className="sp" /><button className="btn ghost" onClick={close} title="Close">✕</button></div>
      <RuntimeList tasks={[t]} showOwner={false} onOpen={(_id, tab) => onOpen(tab)} />
      <div className="rtb-pop-f">
        <button className="btn" onClick={() => onOpen('browser')}>Browser tab</button>
        <button className="btn" onClick={() => onOpen('procs')}>Processes tab</button>
        <button className="btn" onClick={() => { popOutBrowser(t.id, `#${t.num} ${t.title}`, '', t.status !== 'archived'); close(); }} title="Show the browser in its own window">Pop out browser</button>
      </div>
    </div>,
    document.body,
  );
}
