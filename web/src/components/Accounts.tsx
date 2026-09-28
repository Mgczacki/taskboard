// Accounts: each account is a settings folder, so several run side by side. Sign in through a terminal here;
// limit resets are used only by you, from this page.
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { MachineInfo, Task } from '../api';
import { fmtWait } from '../api';
import { Terminal } from './Terminal';

export interface Account {
  id: string; agent: 'claude' | 'codex'; name: string; dir: string; isDefault?: boolean; maxParallel: number;
  limited?: { at: string; note: string }; status: { signedIn: boolean; who?: string }; running: number;
  usage?: { windows: { label: string; usedPct: number; resetsAt?: number }[]; at: string; source: string; plan?: string };
}
// "5-hour 12% · weekly 66%" (windows that already reset are left out)
export const usageText = (a: Account) => (a.usage?.windows || []).filter(w => !w.resetsAt || w.resetsAt > Date.now()).map(w => `${w.label} ${w.usedPct}%`).join(' · ');
const resetText = (ms?: number) => {
  if (!ms) return '';
  const d = new Date(ms), mins = Math.round((ms - Date.now()) / 60000);
  return mins < 0 ? 'reset' : mins < 60 * 20 ? `resets in ${fmtWait(mins)} (${d.toTimeString().slice(0, 5)})` : `resets ${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.toTimeString().slice(0, 5)}`;
};
function UsageBars({ a }: { a: Account }) {
  if (!a.usage) return <span className="sub">{a.agent === 'claude' ? 'Shows up once a Taskboard Claude Code session on this account runs (read from its status line).' : 'Shows up once this account has a Codex session (read from its session files).'}</span>;
  const ago = Math.round((Date.now() - Date.parse(a.usage.at)) / 60000);
  return <div className="usage">
    {a.usage.windows.map(w => { const done = !!w.resetsAt && w.resetsAt < Date.now(); const pct = done ? 0 : w.usedPct; return (
      <div key={w.label} className="uw" title={`${w.label} window: ${w.usedPct}% used${w.resetsAt ? ' · ' + resetText(w.resetsAt) : ''}`}>
        <span className="ul">{w.label}</span>
        <span className="ubar"><span className={pct >= 90 ? 'hi' : pct >= 70 ? 'mid' : ''} style={{ width: `${Math.min(100, pct)}%` }} /></span>
        <span className="up">{done ? 'reset' : `${w.usedPct}%`}</span><span className="sub">{done ? '' : resetText(w.resetsAt)}</span>
      </div>); })}
    <div className="sub">{a.usage.plan ? `${a.usage.plan} plan · ` : ''}as of {ago < 1 ? 'just now' : fmtWait(ago) + ' ago'} · {a.usage.source}</div>
  </div>;
}
const post = (path: string, body: unknown = {}) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j; });
export const loadAccounts = (fresh = false) => fetch('/api/accounts' + (fresh ? '?fresh=1' : '')).then(r => r.json()) as Promise<Account[]>;
const short = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');

// This machine's controller: its name (shown in the Claude app as "Taskboard controller · <name>"), whether it starts
// with Taskboard, and Remote Control (Claude Code only).
function ControllerBox({ ctl, setErr }: { ctl?: Task; setErr: (s: string) => void }) {
  const [info, setInfo] = useState<MachineInfo | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.info().then(i => { setInfo(i); setName(i.machine); }); }, [ctl?.remoteUrl, ctl?.agent]);
  if (!info) return null;
  const save = async (p: { name?: string; autostart?: boolean; remoteControl?: boolean }) => {
    setBusy(true); try { const i = await api.updateInfo(p); setInfo(i); setName(i.machine); } catch (e) { setErr(String((e as Error).message || e)); } setBusy(false);
  };
  const s = info.settings.controller, isClaude = (ctl?.agent || 'claude') === 'claude';
  return (
    <div className="ctl-box">
      <div className="ctl-row"><b>This machine</b>
        <input type="text" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} onBlur={() => { if (name.trim() && name.trim() !== info.machine) save({ name }); }} title="The name the controller uses for itself, and its session name in the Claude app" />
        <span className="sub">host {info.host} · one Taskboard server per machine</span></div>
      <label className="opt" title="When the Taskboard server starts, it starts the controller; if the controller exits, Taskboard starts it again within a minute"><input type="checkbox" checked={s.autostart} disabled={busy} onChange={e => save({ autostart: e.target.checked })} /> Start the controller with Taskboard and keep it running</label>
      <label className="opt" title={isClaude ? 'Lets you continue the controller from claude.ai/code or the Claude mobile app' : 'Remote Control is a Claude Code feature; it is off while the controller runs Codex'}><input type="checkbox" checked={s.remoteControl} disabled={busy || !isClaude} onChange={e => save({ remoteControl: e.target.checked })} /> Remote Control: reach the controller from the Claude app as “{info.controller?.label || 'Taskboard controller · ' + info.machine}”{!isClaude && ' (Claude Code only)'}</label>
      {isClaude && s.remoteControl && <div className="sub">{ctl?.remoteUrl ? <>Open it on any device: <a href={ctl.remoteUrl} target="_blank" rel="noreferrer">{ctl.remoteUrl}</a> — in the Claude mobile app it is listed under Code.</> : 'The link appears here once the controller runs with Remote Control. After a change, the controller restarts by itself as soon as it is between turns (its conversation continues).'}</div>}
    </div>
  );
}

export function AccountsPage({ tasks }: { tasks: Task[] }) {
  const [list, setList] = useState<Account[]>([]);
  const [term, setTerm] = useState<null | { title: string; session: string; note: string }>(null);
  const [confirm, setConfirm] = useState<Account | null>(null);
  const [adding, setAdding] = useState<{ agent: 'claude' | 'codex'; name: string } | null>(null);
  const [err, setErr] = useState('');
  const [movingCtl, setMovingCtl] = useState(false);
  const ctl = tasks.find(t => t.role === 'controller');
  const load = (fresh = false) => loadAccounts(fresh).then(setList).catch(e => setErr(String(e.message || e)));
  useEffect(() => { load(); const i = setInterval(() => load(), 15000); return () => clearInterval(i); }, []);
  useEffect(() => { load(); }, [tasks.length]);

  const signIn = async (a: Account) => { try { const r = await post(`/api/accounts/${a.id}/login`); setTerm({ title: `Sign in: ${a.name}`, session: r.session, note: a.agent === 'claude' ? 'Follow the steps in the terminal; the browser opens on this Mac. Close this window when it says you are signed in.' : 'Follow the steps in the terminal (it prints a link or a device code). Close this window when it says you are logged in.' }); } catch (e) { setErr(String((e as Error).message)); } };
  const reset = async (a: Account) => {
    setConfirm(null);
    try {
      const r = await post(`/api/accounts/${a.id}/reset`);
      if (r.open) { window.open(r.open, '_blank'); setErr(r.note); return; }
      setTerm({ title: `Limit reset: ${a.name}`, session: r.session, note: 'Claude Code runs /limit-reset here. It clears the 5-hour limit once a week; the weekly limit still applies. Close this window when it is done.' });
    } catch (e) { setErr(String((e as Error).message)); }
  };
  const tasksOn = (a: Account) => tasks.filter(t => (t.account || (t.agent === 'claude' ? 'claude-default' : 'codex-default')) === a.id && t.status !== 'archived');

  return (
    <div className="acc-page">
      <div className="acc-head">
        <div><h2>Accounts</h2><p>Each account is its own settings folder (<code>CLAUDE_CONFIG_DIR</code> for Claude Code, <code>CODEX_HOME</code> for Codex), so accounts run side by side and each task uses one. New tasks pick the least busy signed-in account that is not at its limit, unless you choose one.</p></div>
        <div style={{ display: 'flex', gap: 8 }}><button className="btn" onClick={() => load(true)}>Check sign-ins</button><button className="btn primary" onClick={() => setAdding({ agent: 'claude', name: '' })}>＋ Add account</button></div>
      </div>
      {err && <div className="banner">{err} <button className="btn ghost" onClick={() => setErr('')}>OK</button></div>}
      <ControllerBox ctl={ctl} setErr={setErr} />
      <div className="ctl-acct">
        <b>Controller runs on</b>
        <select className="acct-sel" value={ctl?.account || 'claude-default'} disabled={movingCtl} onChange={async e => { setMovingCtl(true); try { await api.setControllerAccount(e.target.value); } catch (x) { setErr(String((x as Error).message || x)); } setMovingCtl(false); load(); }}>
          {(['claude', 'codex'] as const).map(ag => <optgroup key={ag} label={ag === 'claude' ? 'Claude Code' : 'Codex'}>
            {list.filter(a => a.agent === ag).map(a => <option key={a.id} value={a.id} disabled={!a.status.signedIn}>{a.name}{a.status.signedIn ? '' : ' (not signed in)'}{a.limited ? ' · at its limit' : ''}{usageText(a) ? ' · ' + usageText(a) : ''}</option>)}
          </optgroup>)}
        </select>
        <span className="sub">{movingCtl ? 'Restarting the controller on that account…' : 'Changing it restarts the controller on that account. Between two Claude Code accounts the conversation continues; switching to another agent or between Codex accounts starts a new conversation with the same instructions. Tasks the controller starts pick their own account.'}</span>
      </div>
      <div className="tb"><table><colgroup><col style={{ width: '20%' }} /><col style={{ width: '16%' }} /><col style={{ width: '30%' }} /><col style={{ width: 90 }} /><col /></colgroup><tbody>
        {list.map(a => (
          <tr key={a.id} className="r">
            <td><span className={`chip agent-${a.agent}`}>{a.agent === 'claude' ? 'Claude Code' : 'Codex'}</span> <b>{a.name}</b><div className="mono" style={{ marginTop: 4 }}>{short(a.dir)}</div></td>
            <td>{a.status.signedIn ? <span className="st-label unread">✓ signed in</span> : <span className="st-label needs-you">not signed in</span>}<div className="sub">{a.status.who || ''}</div></td>
            <td>{a.limited && <><span className="st-label stopped">stopped by a limit</span><div className="sub">since {fmtWait(Math.round((Date.now() - Date.parse(a.limited.at)) / 60000))} ago · {a.limited.note}</div></>}<UsageBars a={a} /></td>
            <td className="mono">{a.running} / {a.maxParallel}<div className="sub">{tasksOn(a).map(t => '#' + t.num).slice(0, 6).join(' ')}</div></td>
            <td className="acts">
              {!a.status.signedIn && <button className="btn primary" onClick={() => signIn(a)}>Sign in</button>}
              {a.status.signedIn && <button className="btn" onClick={() => signIn(a)} title="Sign in again or switch the login in this folder">Sign in again</button>}
              <button className="btn" onClick={() => setConfirm(a)} title="Only you can use resets; the controller cannot">↺ Limit reset…</button>
              {a.limited && <button className="btn ghost" onClick={() => post(`/api/accounts/${a.id}/clear-limit`).then(() => load())}>Clear limit mark</button>}
              {!a.isDefault && <button className="btn ghost" onClick={() => { if (confirmRemove(a)) fetch(`/api/accounts/${a.id}`, { method: 'DELETE' }).then(() => load()); }}>Remove</button>}
            </td>
          </tr>
        ))}
      </tbody></table></div>
      <p className="sub" style={{ marginTop: 14 }}>Limits are detected when a task stops with a rate-limit error; the mark clears when a turn on that account succeeds. Removing an account only removes it from Taskboard; its folder and login stay on disk.</p>

      {adding && <div className="scrim open" onMouseDown={e => { if (e.target === e.currentTarget) setAdding(null); }}>
        <div className="modal" style={{ width: 460 }}>
          <header><h2>Add account</h2><button className="btn ghost icon" onClick={() => setAdding(null)}>✕</button></header>
          <div className="body">
            <div className="field"><label>Agent</label><div className="seg"><button className={adding.agent === 'claude' ? 'on' : ''} onClick={() => setAdding({ ...adding, agent: 'claude' })}>Claude Code</button><button className={adding.agent === 'codex' ? 'on' : ''} onClick={() => setAdding({ ...adding, agent: 'codex' })}>Codex</button></div></div>
            <div className="field"><label>Name</label><input type="text" autoFocus value={adding.name} onChange={e => setAdding({ ...adding, name: e.target.value })} placeholder="e.g. Work, Personal Max, Client X" /></div>
            <div className="help" style={{ fontSize: 12, color: 'var(--dim)' }}>Creates a new settings folder like <code>~/.{adding.agent}-{(adding.name || 'name').toLowerCase().replace(/[^a-z0-9]+/g, '-')}</code>. Sign in to it next.</div>
          </div>
          <footer><span style={{ flex: 1 }} /><button className="btn" onClick={() => setAdding(null)}>Cancel</button><button className="btn primary" onClick={async () => { if (!adding.name.trim()) return; try { const a = await post('/api/accounts', adding); setAdding(null); await load(); signIn(a); } catch (e) { setErr(String((e as Error).message)); } }}>Add and sign in</button></footer>
        </div>
      </div>}

      {confirm && <div className="scrim open" onMouseDown={e => { if (e.target === e.currentTarget) setConfirm(null); }}>
        <div className="modal" style={{ width: 520 }}>
          <header><h2>Use a limit reset on {confirm.name}?</h2><button className="btn ghost icon" onClick={() => setConfirm(null)}>✕</button></header>
          <div className="body" style={{ fontSize: 13, color: 'var(--muted)' }}>
            {confirm.agent === 'claude'
              ? <><div><b style={{ color: 'var(--text)' }}>What it does:</b> runs <code>/limit-reset</code> in a Claude Code session using <code>{short(confirm.dir)}</code>. It clears the 5-hour limit; the weekly limit still applies. Each account can do this about once a week, and some accounts do not have it yet.</div>
                <div><b style={{ color: 'var(--text)' }}>Waiting on this account:</b> {tasksOn(confirm).filter(t => ['stopped', 'needs-you'].includes(t.status)).map(t => `#${t.num}`).join(', ') || 'nothing'}</div></>
              : <div>Codex has no command-line reset. This opens the Codex usage page, where you can spend a banked reset.</div>}
            <div>Only you can do this; the controller agent cannot.</div>
          </div>
          <footer><span style={{ flex: 1 }} /><button className="btn" onClick={() => setConfirm(null)}>Cancel</button><button className="btn primary" onClick={() => reset(confirm)}>{confirm.agent === 'claude' ? 'Run /limit-reset' : 'Open the usage page'}</button></footer>
        </div>
      </div>}

      {term && <div className="scrim open">
        <div className="modal" style={{ width: 900 }}>
          <header><h2>{term.title}</h2><button className="btn ghost icon" onClick={() => { setTerm(null); load(true); }}>✕</button></header>
          <div className="body"><div className="sub">{term.note}</div><div style={{ height: 420, display: 'flex', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}><Terminal taskId="" session={term.session} autoFocus /></div></div>
          <footer><span style={{ flex: 1 }} /><button className="btn primary" onClick={() => { setTerm(null); load(true); }}>Done</button></footer>
        </div>
      </div>}
    </div>
  );
}
function confirmRemove(a: Account) { return window.confirm(`Remove ${a.name} from Taskboard? Its folder ${a.dir} and its login stay on disk.`); }
