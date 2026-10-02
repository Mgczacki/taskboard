// The browser of a task (or the template browser): a screencast of one tab over /ws/browser, with the tab strip, an
// address bar, and mouse and key input sent back to the page (server/task-browser.ts). The view can pop out into a
// floating window inside the page; only one view of a browser streams at a time, so the panel shows a note meanwhile.
// The sound switch (SoundSwitch) is in both views: a browser starts muted until the user turns its sound on.
// The server sends the shown tab's loading state and history ("nav"), so back, forward and reload work like Chrome's.
// Keys with Cmd: L focuses the address, R reloads, [ and ] go back and forward, V pastes, C and X copy. The other keys
// go to the page. Copy: after a mouse-up or a selection key the view asks the page for its selection ("copy" with
// peek, answered by "copied") and keeps it, so the browser's own copy event can put it on the clipboard at once.
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
  const [big, setBig] = useState(false);
  const toggle = () => { host.classList.toggle('big'); setBig(host.classList.contains('big')); };
  const drag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const sx = e.clientX, sy = e.clientY, l = host.offsetLeft, t = host.offsetTop; host.classList.add('moving');
    const mv = (ev: PointerEvent) => { host.style.left = l + ev.clientX - sx + 'px'; host.style.top = Math.max(0, t + ev.clientY - sy) + 'px'; };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); host.classList.remove('moving'); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  };
  return (
    <>
      <div className="fw-h" onPointerDown={drag} onDoubleClick={toggle} onMouseDown={() => { host.style.zIndex = String(++z); }}>
        <div className="fw-t"><b>{title}</b><span>{sub}</span></div>
        <button className="bw-ib" onClick={toggle} aria-label={big ? 'Smaller window' : 'Larger window'} title="Make the window larger or smaller (double-click the title bar)">{big ? <Icon d={I.shrink} /> : <Icon d={I.grow} />}</button>
        <button className="bw-ib" onClick={close} aria-label="Put the browser back" title="Put the browser back in the task panel"><Icon d={I.close} /></button>
      </div>
      <div className="fw-b"><BrowserView id={id} autostart={autostart} floating /></div>
    </>
  );
}

// ---------- icons (24 x 24 paths, drawn with the text colour) ----------
const I = {
  back: 'M15 6l-6 6 6 6', forward: 'M9 6l6 6-6 6', reload: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6', stop: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14', close: 'M7 7l10 10M17 7L7 17', lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z', info: 'M12 8h.01M11 12h1v5h1M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9M12 3C9.5 5.6 8.2 8.6 8.2 12s1.3 6.4 3.8 9',
  sound: 'M5 9v6h4l5 4V5L9 9H5zM17 9a4 4 0 0 1 0 6M19.5 6.5a8 8 0 0 1 0 11', muted: 'M5 9v6h4l5 4V5L9 9H5zM17 9l5 6M22 9l-5 6',
  popout: 'M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5', power: 'M12 3v8M7.1 6.3a7 7 0 1 0 9.8 0',
  grow: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5', shrink: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5', copy: 'M9 9h10v11H9zM5 15V4h10',
};
function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return <svg className="bw-svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}

// The page icon from Chrome's tab list, or the first letter of the site when the page has none or it fails to load.
function Favicon({ tab }: { tab: BrowserTab }) {
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [tab.faviconUrl]);
  const host = siteOf(tab.url);
  if (tab.faviconUrl && !bad) return <img className="bw-fav" src={tab.faviconUrl} alt="" referrerPolicy="no-referrer" onError={() => setBad(true)} />;
  return host ? <span className="bw-fav letter">{host[0].toUpperCase()}</span> : <span className="bw-fav"><Icon d={I.globe} size={14} /></span>;
}
const siteOf = (url: string) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, '') : ''; } catch { return ''; } };

// The address as Chrome shows it when the field is not focused: the host in full colour, the rest dimmed.
function urlParts(url: string): { scheme: string; host: string; rest: string; secure: boolean | null } {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return { scheme: '', host: '', rest: url, secure: null };
    return { scheme: u.protocol === 'http:' ? 'http://' : '', host: u.host, rest: (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash, secure: u.protocol === 'https:' };
  } catch { return { scheme: '', host: '', rest: url, secure: null }; }
}

// ---------- the view ----------
const MOD = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const BUTTON = ['left', 'middle', 'right'] as const;

export function BrowserView({ id, title = '', autostart = false, floating = false, archived = false, isTemplate = false }: { id: string; title?: string; autostart?: boolean; floating?: boolean; archived?: boolean; isTemplate?: boolean }) {
  const isPopped = usePopped(id);
  if (isPopped && !floating) return (
    <div className="bw-empty"><div className="bw-card">
      <div className="bw-card-icon"><Icon d={I.popout} size={28} /></div>
      <h3>This browser is in a floating window</h3>
      <div className="bw-actions"><button className="btn primary" onClick={() => popped.get(id)?.()}>Put it back here</button></div>
    </div></div>
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
  const [nav, setNav] = useState({ loading: false, canBack: false, canForward: false });
  const [err, setErr] = useState('');
  const [flash, setFlash] = useState('');
  const [addr, setAddr] = useState('');
  const [editing, setEditing] = useState(false);
  const [framed, setFramed] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const frameSize = useRef({ w: 1280, h: 800 });
  const ws = useRef<WebSocket | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const selection = useRef(''), peekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const peek = () => { clearTimeout(peekTimer.current); peekTimer.current = setTimeout(() => send({ type: 'copy', peek: true }), 120); };
  const send = (m: object) => { if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(m)); };
  const note = (text: string) => { setFlash(text); clearTimeout(flashTimer.current); flashTimer.current = setTimeout(() => setFlash(''), 1600); };

  useEffect(() => {
    let closed = false, retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const s = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/browser?id=${encodeURIComponent(id)}${autostart ? '&start=1' : ''}`);
      ws.current = s;
      s.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.type === 'frame') { frameSize.current = { w: m.w, h: m.h }; if (img.current) img.current.src = 'data:image/jpeg;base64,' + m.data; setFramed(true); setRunning(true); }
        else if (m.type === 'tabs') { setTabs(m.tabs); setRunning(true); setAgents(m.agents || 0); setMuted(m.muted ?? null); setErr(''); }
        else if (m.type === 'active') setActive(m.id);
        else if (m.type === 'nav') setNav({ loading: !!m.loading, canBack: !!m.canBack, canForward: !!m.canForward });
        else if (m.type === 'copied') {
          const text = typeof m.text === 'string' ? m.text : '';
          // a copy that came before the kept selection was fresh: write the fresh text (the key press still allows it)
          if (!m.peek && text && text !== selection.current) navigator.clipboard?.writeText(text).then(() => note('Copied'), () => {});
          selection.current = text;
        }
        else if (m.type === 'state') { setRunning(m.running); setState(m); setMuted(m.muted ?? null); if (!m.running) { setTabs([]); setActive(''); setFramed(false); if (img.current) img.current.removeAttribute('src'); } }
        else if (m.type === 'error') setErr(m.message);
      };
      s.onopen = () => sendSize();
      s.onclose = () => { if (!closed) retry = setTimeout(connect, 2000); };
    };
    connect();
    return () => { closed = true; clearTimeout(retry); clearTimeout(flashTimer.current); clearTimeout(peekTimer.current); ws.current?.close(); };
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
  useEffect(() => { if (!editing) setAddr(activeTab?.url === 'about:blank' ? '' : activeTab?.url || ''); }, [activeTab?.url, editing]);

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
  const back = () => send({ type: 'nav', action: 'back' });
  const forward = () => send({ type: 'nav', action: 'forward' });
  const reload = () => send({ type: 'nav', action: nav.loading ? 'stop' : 'reload' });
  const focusAddress = () => { urlInput.current?.focus(); urlInput.current?.select(); };
  // Cmd shortcuts of the browser itself; returns true when the key is handled here and must not reach the page
  const shortcut = (e: React.KeyboardEvent) => {
    if (!e.metaKey || e.altKey || e.ctrlKey) return false;
    const k = e.key.toLowerCase();
    if (k === 'l') focusAddress();
    else if (k === 'r') reload();
    else if (e.key === '[') back();
    else if (e.key === ']') forward();
    else return false;
    return true;
  };
  const key = (e: React.KeyboardEvent, down: boolean) => {
    if (e.metaKey && ['v', 'c', 'x'].includes(e.key.toLowerCase())) return; // these go through the paste, copy and cut events
    if (down && shortcut(e)) { e.preventDefault(); return; }
    if (e.metaKey && ['l', 'r', '[', ']'].includes(e.key.toLowerCase())) { e.preventDefault(); return; } // the key up of a shortcut
    e.preventDefault();
    send({ type: 'key', down, key: e.key, code: e.code, keyCode: e.keyCode, modifiers: MOD(e) });
    if (!down && (e.shiftKey || e.metaKey || e.altKey)) peek(); // Shift+Arrow, Cmd+A and the like change the selection
  };
  const copy = (e: React.ClipboardEvent, cut: boolean) => {
    e.preventDefault();
    e.clipboardData.setData('text/plain', selection.current);
    note(selection.current ? (cut ? 'Cut' : 'Copied') : 'Nothing selected');
    send({ type: 'copy', cut });
  };

  const go = () => { setEditing(false); if (addr.trim()) send({ type: 'nav', action: 'go', url: addr.trim() }); screen.current?.focus(); };
  const startNow = () => { setErr(''); send({ type: 'start' }); };

  if (running === false) return (
    <div className="bw-empty"><div className="bw-card">
      <div className="bw-card-icon"><Icon d={I.globe} size={28} /></div>
      <h3>{archived ? 'The browser is closed' : isTemplate ? 'The template browser is closed' : state?.suspended ? 'The browser is closed while the task is suspended' : state?.idleStopped ? 'The browser stopped because nobody used it' : 'The browser is not running'}</h3>
      <p>{archived ? 'The task is archived. The profile is kept until the task is removed.'
        : isTemplate ? 'Sign in here once. New task browsers copy this profile.'
        : state?.suspended ? 'It opens again when the task resumes.'
        : state?.idleStopped ? `No agent used it and no one viewed it for ${state.idleStopMinutes} minutes${state.stoppedAt ? `, so it stopped at ${new Date(state.stoppedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}. It starts again when the agent uses it, or when you start it.`
        : 'Opening this tab does not start it. It starts when the agent uses it, or when you start it.'}</p>
      {!archived && <div className="bw-actions">
        <button className="btn primary" onClick={startNow}>{isTemplate ? 'Open the template browser' : 'Start the browser'}</button>
        <SoundSwitch id={id} muted={muted} running={false} agents={0} labeled onDone={s => { setState(s); setMuted(s.muted); }} onError={setErr} />
      </div>}
      {!!state?.tabs.length && <div className="bw-saved">
        <div className="bw-saved-h">Opens at the next start</div>
        {state.tabs.map(t => <div key={t.id} className="bw-saved-row" title={t.url}><Favicon tab={t} /><span>{t.url}</span></div>)}
      </div>}
      {state?.error && <div className="banner">{state.error}</div>}
      {err && <div className="banner">{err}</div>}
      {!isTemplate && state && <div className="bw-card-foot">
        <span>{state.profile ? `Profile ${state.copiedFromTemplate ? `copied from the template on ${new Date(state.copiedFromTemplate).toLocaleDateString()}` : 'without a template copy'}.` : 'The first start copies the template profile.'}</span>
        {state.profile && !archived && <button className="btn ghost" onClick={() => api.browserAction(id, 'reset').then(setState).catch(e => setErr(String(e.message || e)))} title="Delete this task's profile and copy the template again. The task loses its own sign-ins.">Reset from template</button>}
      </div>}
    </div></div>
  );

  const parts = urlParts(addr);
  return (
    <div className="bw">
      <div className="bw-tabs" onDoubleClick={e => { if (e.target === e.currentTarget) send({ type: 'new', url: 'about:blank' }); }}>
        {tabs.map(t => (
          <div key={t.id} className={`bw-tab ${t.id === active ? 'on' : ''}`} onClick={() => send({ type: 'select', id: t.id })}
            onAuxClick={e => { if (e.button === 1) { e.preventDefault(); send({ type: 'close', id: t.id }); } }} title={t.title ? `${t.title}\n${t.url}` : t.url}>
            {t.id === active && nav.loading ? <span className="bw-spin" aria-label="Loading" /> : <Favicon tab={t} />}
            <span className="t">{t.title && t.title !== t.url ? t.title : siteOf(t.url) || (t.url === 'about:blank' ? 'New tab' : t.url)}</span>
            <button className="bw-x" onClick={e => { e.stopPropagation(); send({ type: 'close', id: t.id }); }} aria-label="Close this tab" title="Close this tab (middle-click)"><Icon d={I.close} size={12} /></button>
          </div>
        ))}
        <button className="bw-ib bw-new" onClick={() => send({ type: 'new', url: 'about:blank' })} aria-label="New tab" title="New tab"><Icon d={I.plus} /></button>
      </div>
      <div className="bw-bar">
        <button className="bw-ib" onClick={back} disabled={!nav.canBack} aria-label="Back" title="Back (⌘[)"><Icon d={I.back} /></button>
        <button className="bw-ib" onClick={forward} disabled={!nav.canForward} aria-label="Forward" title="Forward (⌘])"><Icon d={I.forward} /></button>
        <button className="bw-ib" onClick={reload} aria-label={nav.loading ? 'Stop loading' : 'Reload'} title={nav.loading ? 'Stop loading' : 'Reload (⌘R)'}><Icon d={nav.loading ? I.stop : I.reload} /></button>
        <div className={`bw-addr ${editing ? 'editing' : ''}`} onClick={() => !editing && focusAddress()}>
          <span className={`bw-site ${parts.secure ? 'secure' : ''}`} title={parts.secure === null ? '' : parts.secure ? 'The connection uses HTTPS' : 'The connection is not secure'}>
            <Icon d={parts.secure === false ? I.info : parts.secure ? I.lock : I.globe} size={14} />
          </span>
          <input ref={urlInput} className="bw-url" value={addr} placeholder="Search or type an address" aria-label="Address"
            onFocus={e => { setEditing(true); e.target.select(); }} onBlur={() => setEditing(false)} onChange={e => setAddr(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') go(); if (e.key === 'Escape') { setEditing(false); setAddr(activeTab?.url || ''); screen.current?.focus(); } }} spellCheck={false} />
          {!editing && addr && <span className="bw-urlview" aria-hidden="true"><span className="dim">{parts.scheme}</span>{parts.host}<span className="dim">{parts.rest}</span></span>}
        </div>
        <div className="bw-side">
          {flash && <span className="bw-chip flash">{flash}</span>}
          {agents > 0 && <span className="bw-chip agent" title="An agent is connected to this browser through its task-browser tools"><i />Agent</span>}
          {!isTemplate && <BrowserMemory id={id} />}
          <SoundSwitch id={id} muted={muted} running agents={agents} onDone={s => setMuted(s.muted)} onError={setErr} />
          {!floating && <button className="bw-ib" onClick={() => popOutBrowser(id, title || (isTemplate ? 'Template browser' : 'Task browser'), isTemplate ? 'Sign in here. New task browsers copy this profile.' : '')} aria-label="Pop out" title="Show the browser in a floating window inside Taskboard"><Icon d={I.popout} /></button>}
          <button className="bw-ib danger" onClick={() => send({ type: 'stop' })} aria-label={isTemplate ? 'Close the template browser' : 'Stop the browser'} title={isTemplate ? 'Close the template browser. New task browsers can copy it only when it is closed.' : 'Stop the browser. Its pages open again at the next start.'}><Icon d={I.power} /></button>
        </div>
        {nav.loading && <div className="bw-progress" />}
      </div>
      {err && <div className="banner">{err} <button className="btn ghost" onClick={() => setErr('')}>OK</button></div>}
      <div className={`bw-screen ${framed ? 'framed' : ''}`} ref={screen} tabIndex={0}
        onMouseDown={e => { screen.current?.focus(); mouse('mousePressed', e, e.detail || 1); }}
        onMouseUp={e => { mouse('mouseReleased', e, e.detail || 1); peek(); }}
        onMouseMove={e => { const now = Date.now(); if (now - lastMove.current > 40) { lastMove.current = now; mouse('mouseMoved', e); } }}
        onContextMenu={e => e.preventDefault()}
        onKeyDown={e => key(e, true)} onKeyUp={e => key(e, false)}
        onPaste={e => { const text = e.clipboardData.getData('text'); if (text) send({ type: 'text', text }); e.preventDefault(); }}
        onCopy={e => copy(e, false)} onCut={e => copy(e, true)}>
        <img ref={img} alt="" draggable={false} />
        {!framed && <div className="bw-wait"><span className="bw-spin" />{running === null ? 'Connecting…' : 'Waiting for the page…'}</div>}
      </div>
    </div>
  );
}

// The memory of a task browser (its footprint, from GET /api/runtime), read every 4 s while the view is open.
function BrowserMemory({ id }: { id: string }) {
  const [memMb, setMemMb] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => api.runtime([id]).then(r => { if (live) setMemMb(r.items.find(i => i.kind === 'browser')?.memMb ?? null); }).catch(() => {});
    void read(); const timer = setInterval(read, 4000);
    return () => { live = false; clearInterval(timer); };
  }, [id]);
  return memMb === null ? null : <span className="bw-chip" title="Memory of all Chrome processes of this browser, counted like Activity Monitor does (footprint). The server reads it at most every 15 s.">{mb(memMb)}</span>;
}

// Sound on or off for this browser (setSound in server/task-browser.ts). Chrome reads --mute-audio only at start, so a
// running browser restarts and opens its tabs again. The restart ends an agent's connection, so the user confirms it.
function SoundSwitch({ id, muted, running, agents, labeled = false, onDone, onError }: { id: string; muted: boolean | null; running: boolean; agents: number; labeled?: boolean; onDone: (s: BrowserStatus) => void; onError: (m: string) => void }) {
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
  const title = muted ? `Muted. Click to turn the sound on${running ? ' (the browser restarts and keeps its tabs)' : ' at the next start'}. Sound plays on the speakers of this Mac, not in the dashboard.` : `Sound on. Click to mute${running ? ' (the browser restarts and keeps its tabs)' : ' at the next start'}.`;
  const label = busy ? (running ? 'Restarting…' : 'Saving…') : muted ? 'Muted' : 'Sound on';
  return (
    <button className={`${labeled ? 'btn' : 'bw-ib'} bw-sound ${muted ? '' : 'on'}`} onClick={toggle} disabled={busy} aria-pressed={!muted} aria-label={label} title={title}>
      {busy ? <span className="bw-spin" /> : <Icon d={muted ? I.muted : I.sound} />}{labeled && <span>{label}</span>}
    </button>
  );
}
