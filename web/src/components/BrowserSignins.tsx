// Shared sign-ins of task browsers (server/browser-signins.ts) on the dashboard:
// - SigninNote: one line on the task browser panel when the template has no sign-ins, or when this browser opted out
// - SigninWindowNote: one line on a sign-in page (signinPages.ts) that offers the template's normal Chrome window for
//   the sign-in, and then reports the copy of that sign-in into this browser
// - SigninDialog: save this browser as the template, sync sign-ins from the template, and reset from the template
// - SigninSettings: the Settings list of the template's sites, live sharing, sign out of all, the task browsers
//   that hold shared sign-ins, and SendSignins (send the template's sign-ins to another machine)
// The server sends site names, counts and dates. No cookie value reaches the dashboard.
import { useCallback, useEffect, useState } from 'react';
import type { BrowserStatus, BrowserTab, SigninOverview, SigninSite } from '../api';
import { api, useStoreValue } from '../api';
import { signinPage } from '../signinPages';

const openSettings = () => dispatchEvent(new CustomEvent('taskboard:open', { detail: { settings: 'taskBrowsers' } }));
const when = (iso?: string) => iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const msg = (e: unknown) => String((e as Error)?.message || e);

// The status fields of sign-in sharing for one task browser, read again after each change and after a start or stop.
export function useSharing(id: string, skip: boolean, running: boolean | null): [BrowserStatus | null, () => void] {
  const [s, setS] = useState<BrowserStatus | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => { if (!skip) api.browser(id).then(setS).catch(() => {}); }, [id, skip, n, running]);
  return [s, useCallback(() => setN(x => x + 1), [])];
}

export type SigninMode = 'save' | 'sync' | 'reset';
export function SigninNote({ status, onMode, onShared }: { status: BrowserStatus | null; onMode: (m: SigninMode) => void; onShared: (on: boolean) => void }) {
  if (!status) return null;
  if (status.noShared) return (
    <div className="banner bw-signins">This browser does not get shared sign-ins.
      <button className="btn ghost" onClick={() => onShared(true)} title="New sign-ins from the template, sync and live sharing reach this browser again">Turn on</button>
    </div>
  );
  if (status.templateSites !== 0) return null;
  return (
    <div className="banner bw-signins">No saved sign-ins. Sign in in Settings, or save this browser's sign-ins for new tasks.
      <button className="btn ghost" onClick={openSettings}>Settings</button>
      {status.profile && <button className="btn ghost" onClick={() => onMode('save')}>Use this browser's sign-ins for new tasks</button>}
    </div>
  );
}

// The task browser is headless Chrome with a debugging port, and Google and some other sites refuse a sign-in there. On a
// sign-in page this line offers the template's normal Chrome window (server/browser-signins.ts signinWindow). While that
// window is open, the line says what to do and reads the status every 2 s. When the user quits the window, the server
// copies the site's cookies into this browser, and the line offers to open the page again.
export function SigninWindowNote({ id, tab, status, reload, onGo }: { id: string; tab: BrowserTab | undefined; status: BrowserStatus | null; reload: () => void; onGo: (url: string) => void }) {
  const [hidden, setHidden] = useState('');
  const [seen, setSeen] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const page = tab ? signinPage(tab.url, tab.title) : null;
  const sw = status?.signinWindow;
  const open = sw?.state === 'open' || sw?.state === 'copying' || busy;
  useEffect(() => { if (!open) return; const t = setInterval(reload, 2000); return () => clearInterval(t); }, [open, reload]);
  const start = async () => {
    if (!page) return;
    setBusy(true); setErr('');
    try { await api.signinWindow(id, page.target); reload(); } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  const sites = sw?.sites.join(', ') || '';
  if (sw?.state === 'open') return (
    <div className="banner bw-signins" role="status">Sign in to {sites} in the Chrome window that opened. Then quit that Chrome (Chrome menu, Quit Google Chrome). This browser gets the sign-in after that.</div>
  );
  if (sw?.state === 'copying') return <div className="banner bw-signins" role="status">The Chrome window closed. Copying the sign-in to {sites} into this browser…</div>;
  if (sw && seen !== sw.at && Date.now() - Date.parse(sw.at) < 10 * 60_000) return (
    <div className="banner bw-signins" role="status">
      {sw.state === 'done' ? `This browser got the sign-in to ${sites} from the normal Chrome window (${sw.cookies ?? 0} cookie(s)). New task browsers get it too.` : `The sign-in to ${sites} did not reach this browser: ${sw.error || 'unknown error'}`}
      {sw.state === 'done' && page && <button className="btn ghost" onClick={() => { setSeen(sw.at); onGo(page.target); }}>Open the page again</button>}
      <button className="btn ghost" onClick={() => setSeen(sw.at)}>OK</button>
    </div>
  );
  if (!page || hidden === tab?.url || status?.noShared) return null;
  return (
    <div className={`banner bw-signins ${page.refused ? 'bw-warn' : ''}`} role="status">
      {page.refused ? 'Google refused the sign-in in this task browser.' : `If ${page.site} refuses the sign-in in this task browser, sign in in a normal Chrome window.`} You sign in there, then quit that Chrome. This browser and new task browsers get the sign-in.
      <button className="btn" disabled={busy} onClick={() => void start()} title="Opens the template profile in a normal Chrome window, without headless mode and without the debugging port">Sign in in a normal window</button>
      <button className="btn ghost" onClick={() => setHidden(tab?.url || '')}>Hide</button>
      {err && <span className="bw-err"> {err}</span>}
    </div>
  );
}

export function SigninDialog({ id, mode, onClose, onDone }: { id: string; mode: SigninMode; onClose: () => void; onDone: (text: string) => void }) {
  const [sites, setSites] = useState<SigninSite[] | null | undefined>(undefined);
  const [tpl, setTpl] = useState<SigninOverview | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (mode === 'save') api.signinSites(id).then(r => setSites(r.sites)).catch(e => setErr(msg(e)));
    api.signinOverview().then(o => { setTpl(o); if (mode === 'sync') { setSites(o.sites); setPick(new Set((o.sites || []).map(s => s.site))); } }).catch(e => setErr(msg(e)));
  }, [id, mode]);
  const run = async () => {
    setBusy(true); setErr('');
    try {
      if (mode === 'save') { const r = await api.signinSaveTemplate(id); onDone(`The template now has ${r.sites.length} site(s) from this browser.`); }
      else if (mode === 'sync') { const r = await api.signinSync(id, [...pick]); onDone(`Added ${r.cookies} cookie(s) for ${r.sites.length} site(s) from the template.`); }
      else { await api.browserAction(id, 'reset'); onDone('The profile was reset.'); }
    } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  const toggle = (s: string) => setPick(p => { const n = new Set(p); if (n.has(s)) n.delete(s); else n.add(s); return n; });
  const title = mode === 'save' ? "Use this browser's sign-ins for new tasks?" : mode === 'sync' ? 'Sync sign-ins from the template' : 'Reset this browser from the template?';
  const list = sites && <ul className="si-list">{sites.map(s => <li key={s.site}>
    {mode === 'sync' ? <label><input type="checkbox" checked={pick.has(s.site)} onChange={() => toggle(s.site)} /> {s.site}</label> : s.site}
    <span className="sub"> {s.cookies} cookie(s){s.lastUsed ? `, last used ${when(s.lastUsed)}` : ''}</span></li>)}</ul>;
  return (
    <div className="scrim open" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal si-modal" role="dialog" aria-label={title}>
        <header><h2>{title}</h2><button className="btn ghost icon" onClick={onClose} disabled={busy} aria-label="Close">✕</button></header>
        <div className="body">
          {mode === 'save' && <>
            <div>The template gets the sign-ins and site data of this browser. Each new task browser copies the template. History, open tabs and caches are not copied.</div>
            <div className="si-warn"><b>Every agent can use these accounts.</b> An agent with a task browser can read its cookies and act as you on these sites.</div>
            {sites === undefined && !err && <div className="sub">Reading the sites…</div>}
            {sites === null && <div className="sub">The sites of this stopped browser cannot be read here. Start the browser to see them.</div>}
            {sites && (sites.length ? <><div>Sites with cookies in this browser:</div>{list}</> : <div>This browser has no cookies.</div>)}
            {tpl?.template.profile && <div className="sub">This replaces the current template{tpl.sites ? ` (${tpl.sites.length} site(s))` : ''}. Task browsers that copied it keep their copy.</div>}
            <div className="sub">A running browser stops and starts again with its pages. The template browser must be closed.</div>
          </>}
          {mode === 'sync' && <>
            <div>The template's cookies of the chosen sites go into this browser. This browser keeps its own sign-ins, tabs and site data.</div>
            <div className="sub">Only cookies are synced. Local storage and IndexedDB of these sites are not, so a site that keeps its sign-in there needs Reset from template. A stopped browser starts for the sync.</div>
            {sites === undefined && !err && <div className="sub">Reading the template…</div>}
            {sites && (sites.length ? list : <div>The template has no sign-ins.</div>)}
          </>}
          {mode === 'reset' && <div>This deletes the profile of this task browser and copies the template again. The browser loses its own sign-ins, site data and history. Its open pages stay saved.</div>}
          {err && <div className="banner">{err}</div>}
        </div>
        <footer><span style={{ flex: 1 }} /><button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className={`btn ${mode === 'reset' ? 'danger' : 'primary'}`} disabled={busy || (mode === 'sync' && !pick.size) || (mode === 'save' && sites === undefined && !err)} onClick={() => void run()}>
            {busy ? 'Working…' : mode === 'save' ? 'Save as the template' : mode === 'sync' ? `Sync ${pick.size} site(s)` : 'Reset'}
          </button></footer>
      </div>
    </div>
  );
}

// ---------- Settings ----------
export function SigninSettings() {
  const [o, setO] = useState<SigninOverview | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [asking, setAsking] = useState(false);
  const [add, setAdd] = useState('');
  const load = () => api.signinOverview().then(setO).catch(e => setErr(msg(e)));
  useEffect(() => { void load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, []);
  const act = async (fn: () => Promise<unknown>, done = '') => { setBusy(true); setErr(''); try { await fn(); setNote(done); await load(); } catch (e) { setErr(msg(e)); } finally { setBusy(false); } };
  if (!o) return <div className="sub">{err || 'Reading the shared sign-ins…'}</div>;
  const live = new Set(o.settings.liveSites);
  const setLive = (patch: { live?: boolean; liveSites?: string[] }) => act(() => api.signinLive(patch));
  const sitesShown = [...new Set([...(o.sites || []).map(s => s.site), ...o.settings.liveSites])].sort();
  const info = new Map((o.sites || []).map(s => [s.site, s]));
  const shared = o.browsers.filter(b => !b.noShared && (b.copiedFromTemplate || b.syncedAt || b.liveSyncAt));
  const out = o.browsers.filter(b => b.noShared);
  const name = (b: { num?: number; title?: string; id: string }) => b.num ? `#${b.num} ${b.title || ''}` : b.id;
  return <>
    <div className="sub">The template keeps sign-ins for these sites. A new task browser copies them at its first start. Names only: Taskboard never shows a cookie value.</div>
    {o.sites === null && <div className="sub">The sites cannot be read while the template is closed (no sqlite3 program). Open the template browser to see them.</div>}
    {sitesShown.length ? <table className="si-table"><thead><tr><th>Site</th><th>Cookies</th><th>Last used</th><th>Live</th><th /></tr></thead><tbody>
      {sitesShown.map(s => <tr key={s}>
        <td>{s}</td><td>{info.get(s)?.cookies ?? '—'}</td><td>{when(info.get(s)?.lastUsed) || '—'}</td>
        <td><input type="checkbox" aria-label={`Share ${s} live`} disabled={busy} checked={live.has(s)} onChange={e => void setLive({ liveSites: e.target.checked ? [...live, s] : [...live].filter(x => x !== s) })} /></td>
        <td><button className="btn ghost" disabled={busy} onClick={() => void act(() => api.signinRemove(s), `${s} was removed from the template.`)} title="Delete the cookies and site data of this site in the template. Task browsers keep the copies they have.">Remove</button></td>
      </tr>)}
    </tbody></table> : <div className="sub">{o.template.profile ? 'The template has no sign-ins.' : 'No template profile yet.'}</div>}
    <label className="opt"><input type="checkbox" disabled={busy} checked={o.settings.live} onChange={e => void setLive({ live: e.target.checked })} /> Share sign-ins between all task browsers live</label>
    <div className="sub">For the sites marked Live only. Every 5 s Taskboard copies new, changed and deleted cookies of these sites between all running task browsers and the template, and keeps them for browsers that start later. So a sign-in in one browser reaches the others, and a sign-out too. Not covered: local storage, IndexedDB and service workers (sites that keep a sign-in there), session cookies after a restart, and sign-ins that a site binds to one device. When two browsers change the same cookie within 5 s, one of them wins. The kept cookies are encrypted in the Taskboard folder (file mode 0600).</div>
    <div className="si-add"><input value={add} onChange={e => setAdd(e.target.value)} placeholder="example.com" aria-label="Add a site to live sharing" spellCheck={false} />
      <button className="btn" disabled={busy || !add.trim()} onClick={() => { const s = add.trim().toLowerCase(); setAdd(''); void setLive({ liveSites: [...live, s] }); }}>Add a live site</button></div>
    <div className="si-row">
      {asking
        ? <><span>Sign out of all? The template profile is deleted, live sharing stops, and every task browser loses the cookies of these sites.</span>
          <button className="btn danger" disabled={busy} onClick={() => { setAsking(false); void act(async () => { const r = await api.signinSignOutAll(); setNote(`Signed out of ${r.sites.length} site(s): ${r.now.length} running browser(s) now, ${r.later.length} at their next start.`); }); }}>Sign out of all</button>
          <button className="btn" onClick={() => setAsking(false)}>Cancel</button></>
        : <button className="btn danger" disabled={busy || (!o.template.profile && !live.size)} onClick={() => setAsking(true)}>Sign out of all…</button>}
    </div>
    {note && <div className="sub">{note}</div>}
    {err && <div className="banner">{err}</div>}
    <SendSignins sites={(o.sites || []).map(x => x.site)} />
    <div className="opt">Task browsers with shared sign-ins</div>
    {shared.length ? <ul className="si-list">{shared.map(b => <li key={b.id}>{name(b)}
      <span className="sub"> {[b.copiedFromTemplate && `copied ${when(b.copiedFromTemplate)}`, b.syncedAt && `synced ${when(b.syncedAt)}`, b.liveSyncAt && o.settings.live && `live ${when(b.liveSyncAt)}`, b.running && 'running', b.agents && `${b.agents} agent connection(s)`].filter(Boolean).join(' · ')}</span></li>)}</ul>
      : <div className="sub">None.</div>}
    {!!out.length && <div className="sub">Opted out (no shared sign-ins): {out.map(name).join(', ')}.</div>}
  </>;
}

// Send the template's sign-ins of the chosen sites to another machine (POST /api/browser-signins/send). That machine
// writes them into its own template, so its new task browsers get them, and Sync gives them to its other task browsers.
function SendSignins({ sites }: { sites: string[] }) {
  const others = useStoreValue(s => s.machines).filter(m => !m.local);
  const [to, setTo] = useState('');
  const [pick, setPick] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  if (!others.length || !sites.length) return null;
  const chosen = pick || new Set(sites);
  const target = others.find(m => m.id === to) || others[0];
  const toggle = (site: string) => { const n = new Set(chosen); if (n.has(site)) n.delete(site); else n.add(site); setPick(n); };
  const send = async () => {
    setBusy(true); setErr(''); setNote('');
    try { const r = await api.signinSend(target.id, [...chosen]); setNote(`Sent ${r.cookies} cookie(s) of ${r.sites.length} site(s) to ${r.machine}. Its new task browsers get them, and Sync gives them to its other task browsers.`); }
    catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  return <>
    <div className="opt">Send sign-ins to another machine</div>
    <div className="sub">The template's cookies of the chosen sites go to the template of the other machine, over its paired link. Local storage and IndexedDB stay here. Some sites end a sign-in that they see on a second machine.</div>
    <ul className="si-list">{sites.map(site => <li key={site}><label><input type="checkbox" checked={chosen.has(site)} onChange={() => toggle(site)} /> {site}</label></li>)}</ul>
    <div className="si-row">
      <select value={target.id} onChange={e => setTo(e.target.value)} aria-label="Machine">{others.map(m => <option key={m.id} value={m.id} disabled={!m.online}>{m.name}{m.online ? '' : ' (offline)'}</option>)}</select>
      <button className="btn" disabled={busy || !chosen.size || !target.online} onClick={() => void send()}>{busy ? 'Sending…' : `Send ${chosen.size} site(s)`}</button>
    </div>
    {note && <div className="sub">{note}</div>}
    {err && <div className="banner">{err}</div>}
  </>;
}
