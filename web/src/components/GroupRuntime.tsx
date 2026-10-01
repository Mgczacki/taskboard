// The browsers and processes of the tasks in one Canvas view (a group or another set of tasks). Each tile shows a
// still frame of the task browser that refreshes every 5 s; a click opens the live browser in a floating window.
import { useEffect, useState } from 'react';
import type { BrowserStatus, Group, Task } from '../api';
import { api } from '../api';
import { Dot } from './ui';
import { popOutBrowser } from './TaskBrowser';
import { ProcList } from './TaskProcs';

export function GroupRuntime({ tasks, group }: { tasks: Task[]; group?: Group }) {
  const local = tasks.filter(t => !t.machine && t.role !== 'controller');
  const [st, setSt] = useState<Record<string, BrowserStatus>>({});
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () => Promise.all(local.map(t => api.browser(t.id).then(s => [t.id, s] as const).catch(() => null)))
      .then(rows => { if (live) { setSt(Object.fromEntries(rows.filter(Boolean) as [string, BrowserStatus][])); setTick(n => n + 1); } });
    void load(); const timer = setInterval(load, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [local.map(t => t.id).join(',')]);
  const totalMb = Object.values(st).reduce((n, s) => n + (s.rssMb || 0), 0);
  const running = Object.values(st).filter(s => s.running).length;
  return (
    <div className="grt">
      <div className="grt-head"><b>Browsers</b><span className="sub">{running} of {local.length} running{totalMb ? ` · about ${totalMb} MB` : ''} · a click opens the live browser</span></div>
      <div className="grt-grid">
        {local.map(t => {
          const s = st[t.id];
          return (
            <div key={t.id} className="grt-tile" onClick={() => popOutBrowser(t.id, `#${t.num} ${t.title}`, '', t.status !== 'archived')} title="Open this task's browser in a floating window">
              <div className="grt-th"><Dot s={t.status} /><span className="num">#{t.num}</span><b>{t.title}</b></div>
              <div className="grt-shot">
                {s?.running ? <img src={`/api/tasks/${encodeURIComponent(t.id)}/browser/shot?t=${tick}`} alt="" onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} onLoad={e => { (e.target as HTMLImageElement).style.visibility = 'visible'; }} />
                  : <span className="sub">{s?.suspended ? 'Browser stopped (task suspended)' : 'Browser not running'}</span>}
                {s?.agents ? <span className="grt-agent">agent connected</span> : null}
              </div>
              <div className="grt-tabs">{(s?.tabs || []).slice(0, 4).map(x => <span key={x.id} className="chip" title={x.url}>{x.title || x.url}</span>)}{(s?.tabs.length || 0) > 4 && <span className="chip">+{(s?.tabs.length || 0) - 4}</span>}</div>
              <div className="grt-foot sub">{s?.running ? `${s.tabs.length} tab(s)${s.rssMb ? ` · ${s.rssMb} MB` : ''}` : s?.tabs.length ? `${s.tabs.length} page(s) saved` : ''}</div>
            </div>
          );
        })}
        {!local.length && <div className="sub">No tasks on this machine in this view.</div>}
      </div>
      {group && <ProcList scope="groups" id={group.id} cwd={local[0]?.cwd} />}
    </div>
  );
}
