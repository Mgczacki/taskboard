// The browser of a task (or the template browser): a screencast of one tab over /ws/browser, with the tab strip, an
// address bar, and mouse and key input sent back to the page (server/task-browser.ts). The view can pop out into a
// floating window inside the page; only one view of a browser streams at a time, so the panel shows a note meanwhile.
// The sound switch (SoundSwitch) is in both views: a browser starts muted until the user turns its sound on.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import type { BrowserStatus, BrowserTab } from '../api';
import { api } from '../api';
import { mb } from '../runtimeText';

// ---------- which browsers are popped out ----------
const popped = new Map<string, () => void>();
const subs = new Set<() => void>();
const notify = () => subs.forEach(f => f());
const usePopped = (id: string) => useSyncExternalStore(f => { subs.add(f); return () => subs.delete(f); }, () => popped.has(id));

let z = 300, n = 0;
export function popOutBrowser(id: string, title: string, sub = '', autostart = false) {
  if (popped.has(id)) return;
  const host = document.createElement('div'); host.className = 'floatwin bw-float'; host.style.zIndex = String(++z);
  const k = n++ % 6;
  Object.assign(host.style, { left: Math.max(20, innerWidth - 1040 - k * 28) + 'px', top: 70 + k * 28 + 'px', width: '980px', height: Math.min(720, innerHeight - 120) + 'px' });
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => { root.unmount(); host.remove(); popped.delete(id); notify(); };
  popped.set(id, close); notify();
  root.render(<FloatBrowser id={id} title={title} sub={sub} close={close} host={host} autostart={autostart} />);
}
function FloatBrowser({ id, title, sub, close, host, autostart }: { id: string; title: string; sub: string; close: () => void; host: HTMLElement; autostart: boolean }) {
  const drag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const sx = e.clientX, sy = e.clientY, l = host.offsetLeft, t = host.offsetTop; host.classList.add('moving');
    const mv = (ev: PointerEvent) => { host.style.left = l + ev.clientX - sx + 'px'; host.style.top = Math.max(0, t + ev.clientY - sy) + 'px'; };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); host.classList.remove('moving'); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  };
  return (
    <>
      <div className="fw-h" onPointerDown={drag} onDoubleClick={() => host.classList.toggle('big')} onMouseDown={() => { host.style.zIndex = String(++z); }}>
        <div className="fw-t"><b>{title}</b><span>{sub}</span></div>
        <button className="btn" onClick={() => host.classList.toggle('big')} title="Make the window larger or smaller (double-click the title bar)">Larger</button>
        <button className="btn icon" onClick={close} title="Put the browser back in the task panel">✕</button>
      </div>
      <div className="fw-b"><BrowserView id={id} autostart={autostart} floating /></div>
    </>
  );
}

// ---------- the view ----------
const MOD = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const BUTTON = ['left', 'middle', 'right'] as const;

export function BrowserView({ id, title = '', autostart = false, floating = false, archived = false, isTemplate = false }: { id: string; title?: string; autostart?: boolean; floating?: boolean; archived?: boolean; isTemplate?: boolean }) {
  const isPopped = usePopped(id);
  if (isPopped && !floating) return (
    <div className="bw-empty"><p>This browser is shown in a floating window.</p><button className="btn" onClick={() => popped.get(id)?.()}>Put it back here</button></div>
  );
  return <Live id={id} title={title} autostart={autostart} floating={floating} archived={archived} isTemplate={isTemplate} />;
}

function Live({ id, title, autostart, floating, archived, isTemplate }: { id: string; title: string; autostart: boolean; floating: boolean; archived: boolean; isTemplate: boolean }) {
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [active, setActive] = useState('');
  const [state, setState] = useState<BrowserStatus | null>(null);
  const [running, setRunning] = useState<boolean | null>(null);
  const [agents, setAgents] = useState(0);
  const [muted, setMuted] = useState<boolean | null>(null);
  const [err, setErr] = useState('');
  const [addr, setAddr] = useState('');
  const [editing, setEditing] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const frameSize = useRef({ w: 1280, h: 800 });
  const ws = useRef<WebSocket | null>(null);
  const send = (m: object) => { if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(m)); };

  useEffect(() => {
    let closed = false, retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const s = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/browser?id=${encodeURIComponent(id)}${autostart ? '&start=1' : ''}`);
      ws.current = s;
      s.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.type === 'frame') { frameSize.current = { w: m.w, h: m.h }; if (img.current) img.current.src = 'data:image/jpeg;base64,' + m.data; setRunning(true); }
        else if (m.type === 'tabs') { setTabs(m.tabs); setRunning(true); setAgents(m.agents || 0); setMuted(m.muted ?? null); setErr(''); }
        else if (m.type === 'active') setActive(m.id);
        else if (m.type === 'state') { setRunning(m.running); setState(m); setMuted(m.muted ?? null); if (!m.running) { setTabs([]); setActive(''); if (img.current) img.current.removeAttribute('src'); } }
        else if (m.type === 'error') setErr(m.message);
      };
      s.onopen = () => sendSize();
      s.onclose = () => { if (!closed) retry = setTimeout(connect, 2000); };
    };
    connect();
    return () => { closed = true; clearTimeout(retry); ws.current?.close(); };
  }, [id]);

  // the page's viewport is the size of this view, so a frame fills it without bars
  const sendSize = () => { const r = screen.current?.getBoundingClientRect(); if (r && r.width > 100 && r.height > 100) send({ type: 'size', w: r.width, h: r.height }); };
  useEffect(() => {
    if (!screen.current) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(sendSize, 200); });
    ro.observe(screen.current);
    return () => { ro.disconnect(); clearTimeout(timer); };
  }, [running]);

  const activeTab = tabs.find(t => t.id === active);
  useEffect(() => { if (!editing) setAddr(activeTab?.url || ''); }, [activeTab?.url, editing]);

  // mouse and keys
  const point = (e: { clientX: number; clientY: number }) => {
    const r = img.current!.getBoundingClientRect();
    return { x: Math.round((e.clientX - r.left) * frameSize.current.w / r.width), y: Math.round((e.clientY - r.top) * frameSize.current.h / r.height) };
  };
  const lastMove = useRef(0);
  const mouse = (event: string, e: React.MouseEvent, clickCount = 0) => {
    if (!img.current) return;
    send({ type: 'mouse', event, ...point(e), button: event === 'mouseMoved' ? (e.buttons ? 'left' : 'none') : BUTTON[e.button] || 'left', buttons: e.buttons, clickCount, modifiers: MOD(e) });
  };
  useEffect(() => {
    const el = screen.current; if (!el) return;
    const wheel = (e: WheelEvent) => { e.preventDefault(); if (img.current) send({ type: 'mouse', event: 'mouseWheel', ...point(e), dx: e.deltaX, dy: e.deltaY, modifiers: MOD(e) }); };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [running]);
  const key = (e: React.KeyboardEvent, down: boolean) => {
    if (e.metaKey && ['v', 'c', 'x'].includes(e.key.toLowerCase())) return; // paste goes through the paste event; copy is not available
    e.preventDefault();
    send({ type: 'key', down, key: e.key, code: e.code, keyCode: e.keyCode, modifiers: MOD(e) });
  };

  const go = () => { setEditing(false); if (addr.trim()) send({ type: 'nav', action: 'go', url: addr.trim() }); };
  const startNow = () => { setErr(''); send({ type: 'start' }); };

  if (running === false) return (
    <div className="bw-empty">
      {archived ? <p>The task is archived. Its browser is closed. The profile is kept until the task is removed.</p>
        : <p>{isTemplate ? 'The template browser is closed.' : state?.suspended ? 'The browser was closed when the task was suspended. It opens again when the task resumes.' : 'The browser is not running. It starts when the agent uses it, or when you start it.'}</p>}
      {!archived && <div><button className="btn primary" onClick={startNow}>{isTemplate ? 'Open the template browser' : 'Start the browser'}</button> <SoundSwitch id={id} muted={muted} running={false} agents={0} onDone={s => { setState(s); setMuted(s.muted); }} onError={setErr} /></div>}
      {!!state?.tabs.length && <div className="bw-saved"><b>Pages that open at the next start</b>{state.tabs.map(t => <div key={t.id} className="sub">{t.url}</div>)}</div>}
      {!isTemplate && state && <div className="sub">{state.profile ? `Profile ${state.copiedFromTemplate ? `copied from the template on ${new Date(state.copiedFromTemplate).toLocaleString()}` : 'without a template copy'}.` : 'The first start copies the template profile.'}</div>}
      {!isTemplate && state?.profile && !archived && <div><button className="btn" onClick={() => api.browserAction(id, 'reset').then(setState).catch(e => setErr(String(e.message || e)))} title="Delete this task's profile and copy the template again. The task loses its own sign-ins.">Reset from template</button></div>}
      {state?.error && <div className="banner">{state.error}</div>}
      {err && <div className="banner">{err}</div>}
    </div>
  );

  return (
    <div className="bw">
      <div className="bw-tabs">
        {tabs.map(t => (
          <div key={t.id} className={`bw-tab ${t.id === active ? 'on' : ''}`} onClick={() => send({ type: 'select', id: t.id })} title={t.url}>
            <span className="t">{t.title || t.url || 'New tab'}</span>
            <button className="x" onClick={e => { e.stopPropagation(); send({ type: 'close', id: t.id }); }} title="Close this tab">×</button>
          </div>
        ))}
        <button className="bw-new" onClick={() => send({ type: 'new', url: 'about:blank' })} title="New tab">＋</button>
      </div>
      <div className="bw-bar">
        <button className="btn icon" onClick={() => send({ type: 'nav', action: 'back' })} title="Back">←</button>
        <button className="btn icon" onClick={() => send({ type: 'nav', action: 'forward' })} title="Forward">→</button>
        <button className="btn icon" onClick={() => send({ type: 'nav', action: 'reload' })} title="Reload">↻</button>
        <input className="bw-url" value={addr} onFocus={e => { setEditing(true); e.target.select(); }} onBlur={() => setEditing(false)} onChange={e => setAddr(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') go(); if (e.key === 'Escape') { setEditing(false); (e.target as HTMLInputElement).blur(); } }} spellCheck={false} />
        {!isTemplate && <BrowserMemory id={id} />}
        <SoundSwitch id={id} muted={muted} running agents={agents} onDone={s => setMuted(s.muted)} onError={setErr} />
        {agents > 0 && <span className="bw-agent" title="An agent is connected to this browser through its task-browser tools">agent connected</span>}
        {!floating && <button className="btn" onClick={() => popOutBrowser(id, title || (isTemplate ? 'Template browser' : 'Task browser'), isTemplate ? 'Sign in here. New task browsers copy this profile.' : '')} title="Show the browser in a floating window inside Taskboard">Pop out</button>}
        <button className="btn" onClick={() => send({ type: 'stop' })} title={isTemplate ? 'Close the template browser. New task browsers can copy it only when it is closed.' : 'Close the browser. Its pages open again at the next start.'}>{isTemplate ? 'Close' : 'Stop'}</button>
      </div>
      {err && <div className="banner">{err} <button className="btn ghost" onClick={() => setErr('')}>OK</button></div>}
      <div className="bw-screen" ref={screen} tabIndex={0}
        onMouseDown={e => { screen.current?.focus(); mouse('mousePressed', e, e.detail || 1); }}
        onMouseUp={e => mouse('mouseReleased', e, e.detail || 1)}
        onMouseMove={e => { const now = Date.now(); if (now - lastMove.current > 40) { lastMove.current = now; mouse('mouseMoved', e); } }}
        onContextMenu={e => e.preventDefault()}
        onKeyDown={e => key(e, true)} onKeyUp={e => key(e, false)}
        onPaste={e => { const text = e.clipboardData.getData('text'); if (text) send({ type: 'text', text }); e.preventDefault(); }}>
        <img ref={img} alt="" draggable={false} />
        {running === null && <div className="bw-wait">Connecting…</div>}
      </div>
    </div>
  );
}

// The memory of a task browser (RSS of its process group, from GET /api/runtime), read every 4 s while the view is open.
function BrowserMemory({ id }: { id: string }) {
  const [memMb, setMemMb] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => api.runtime([id]).then(r => { if (live) setMemMb(r.items.find(i => i.kind === 'browser')?.memMb ?? null); }).catch(() => {});
    void read(); const timer = setInterval(read, 4000);
    return () => { live = false; clearInterval(timer); };
  }, [id]);
  return memMb === null ? null : <span className="bw-mem sub" title="Resident memory (RSS) of this browser's processes, read with ps. Shared pages count in each process.">{mb(memMb)}</span>;
}

// Sound on or off for this browser (setSound in server/task-browser.ts). Chrome reads --mute-audio only at start, so a
// running browser restarts and opens its tabs again. The restart ends an agent's connection, so the user confirms it.
function SoundSwitch({ id, muted, running, agents, onDone, onError }: { id: string; muted: boolean | null; running: boolean; agents: number; onDone: (s: BrowserStatus) => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  if (muted === null) return null;
  const on = muted; // the click turns the sound on when the browser is muted
  const agentNote = (n: number) => `An agent is connected to this browser (${n}). The restart ends its connection, and the agent must connect again.`;
  const toggle = async () => {
    const restart = `The browser restarts to ${on ? 'turn the sound on' : 'mute it'}. Its tabs open again.${on ? ' The sound plays on the speakers of this Mac, not in the dashboard.' : ''}`;
    if (running && !confirm(agents ? `${restart}\n\n${agentNote(agents)}` : restart)) return;
    setBusy(true);
    try {
      let force = running && agents > 0;
      for (;;) {
        try { onDone(await api.browserSound(id, on, force)); break; }
        catch (e) {
          // an agent connected after the view showed its count: ask again
          if (!force && /agent is connected/i.test(String((e as Error).message)) && confirm(`${restart}\n\n${agentNote(1)}`)) { force = true; continue; }
          throw e;
        }
      }
    } catch (e) { onError(String((e as Error).message || e)); } finally { setBusy(false); }
  };
  return (
    <button className={`btn bw-sound ${muted ? '' : 'on'}`} onClick={toggle} disabled={busy} aria-pressed={!muted}
      title={muted ? `Muted. Click to turn the sound on${running ? ' (the browser restarts and keeps its tabs)' : ' at the next start'}. Sound plays on the speakers of this Mac, not in the dashboard.` : `Sound on. Click to mute${running ? ' (the browser restarts and keeps its tabs)' : ' at the next start'}.`}>
      {busy ? (running ? 'Restarting…' : 'Saving…') : muted ? '🔇 Muted' : '🔊 Sound on'}
    </button>
  );
}
