// Settings: what the controller and other agents may do without asking, and this machine's controller.
import { useEffect, useState } from 'react';
import type { MachineInfo, Task } from '../api';
import { api, autoReload, confirmEnd, setAutoReload, setConfirmEnd } from '../api';
import { ControllerBox, loadAccounts } from './Accounts';
import type { Account } from './Accounts';
import type { KeyAction } from '../keys';
import { ACTIONS, CTX_NAME, comboOf, fmtCombo, isCustom, keysOf, resetKeys, setKeys, setRecording, useKeymap } from '../keys';

export function SettingsPage({ tasks }: { tasks: Task[] }) {
  const [info, setInfo] = useState<MachineInfo | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [reloadOn, setReloadOn] = useState(autoReload());
  const [askEnd, setAskEnd] = useState(confirmEnd());
  const [accts, setAccts] = useState<Account[]>([]);
  useEffect(() => { api.info().then(setInfo).catch(e => setErr(String(e.message || e))); loadAccounts().then(setAccts).catch(() => {}); }, []);
  const save = async (p: { controllerNeedsApproval?: boolean; agentsNeedApproval?: boolean; askAccount?: string; askModel?: string }) => {
    setBusy(true); try { setInfo(await api.updateInfo(p)); } catch (e) { setErr(String((e as Error).message || e)); } setBusy(false);
  };
  const ctl = tasks.find(t => t.role === 'controller');
  const p = info?.settings.permissions;
  return (
    <div className="acc-page">
      <div className="acc-head"><div><h2>Settings</h2><p>For this machine ({info?.machine || '…'}).</p></div></div>
      {err && <div className="banner">{err} <button className="btn ghost" onClick={() => setErr('')}>OK</button></div>}
      <h3 className="set-h">Managing tasks</h3>
      <p className="sub">Starting tasks, typing into them, setting them aside and archiving them with <code>tb</code> can run at once or wait for your Approve / Deny card on the dashboard. Neither Claude Code, Codex nor Antigravity asks separately for <code>tb</code> commands of the controller; this is the one place that decides.</p>
      {p && <div className="ctl-box">
        <label className="opt" title="When on, the controller's tb new / send / park / archive run immediately"><input type="checkbox" disabled={busy} checked={!p.controllerNeedsApproval} onChange={e => save({ controllerNeedsApproval: !e.target.checked })} /> <b>The controller may create and manage tasks without asking</b></label>
        <label className="opt" title="Agents other than the controller that use tb to start or type into tasks"><input type="checkbox" disabled={busy} checked={!p.agentsNeedApproval} onChange={e => save({ agentsNeedApproval: !e.target.checked })} /> Other agents may start, type into, set aside and archive tasks without asking</label>
        <div className="sub">A change reaches the controller when it next restarts, which Taskboard does by itself as soon as the controller is between turns (its conversation continues). Releasing or rolling back Taskboard and stopping its server stay blocked for every agent.</div>
      </div>}
      <h3 className="set-h">Canvas</h3>
      <div className="ctl-box">
        <label className="opt" title="The ⏻ button in a canvas window's header ends the tmux session and archives the task"><input type="checkbox" checked={askEnd} onChange={e => { setConfirmEnd(e.target.checked); setAskEnd(e.target.checked); }} /> Ask before ⏻ in a window header ends and archives the task</label>
        <div className="sub">Saved for this app or browser. When it is off, ⏻ acts at once and a message offers Restore.</div>
      </div>
      <KeySettings />
      <h3 className="set-h">Questions about a session</h3>
      <p className="sub">The <b>?</b> button on a canvas window asks a separate Claude Code agent about that session. It reads the terminal and the transcript, and it cannot change anything. The session's own agent does not see the question. A question uses this account's usage: about $0.01 when the terminal answers it, and about $0.05 when the agent reads the transcript (at most $0.50).</p>
      {info && <div className="ctl-box">
        <label className="opt">Account <select disabled={busy} value={info.settings.ask.account} onChange={e => save({ askAccount: e.target.value })}>{accts.filter(a => a.agent === 'claude').map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label className="opt">Model <select disabled={busy} value={info.settings.ask.model} onChange={e => save({ askModel: e.target.value })}>{['sonnet', 'haiku', 'opus'].map(m => <option key={m} value={m}>{m[0].toUpperCase() + m.slice(1)}</option>)}</select></label>
      </div>}
      <h3 className="set-h">Updates</h3>
      <div className="ctl-box">
        <label className="opt" title="After a release (pnpm release), open Taskboard windows reload themselves and keep their place (page, canvas view, open task)"><input type="checkbox" checked={reloadOn} onChange={e => { setAutoReload(e.target.checked); setReloadOn(e.target.checked); }} /> Reload automatically when Taskboard is updated</label>
        <div className="sub">Saved for this app or browser. When it is off, a bar offers the reload instead.</div>
      </div>
      <h3 className="set-h">Controller</h3>
      <ControllerBox ctl={ctl} setErr={setErr} />
    </div>
  );
}

// Keyboard shortcuts: every action in keys.ts with its keys. ＋ waits for the next key and adds it; × removes a key.
function KeySettings() {
  useKeymap();
  const [adding, setAdding] = useState<string | null>(null);
  useEffect(() => {
    if (!adding) return;
    setRecording(true);
    const on = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.code === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) { setAdding(null); return; }
      const c = comboOf(e); if (!c) return; // a modifier key alone: wait for the rest
      if (!keysOf(adding).includes(c)) setKeys(adding, [...keysOf(adding), c]);
      setAdding(null);
    };
    addEventListener('keydown', on, true);
    return () => { removeEventListener('keydown', on, true); setRecording(false); };
  }, [adding]);
  // a key set for two actions: in the same place both would run; an Anywhere key gives way to the page's own key
  const users = new Map<string, KeyAction[]>();
  ACTIONS.forEach(a => keysOf(a.id).forEach(k => users.set(k, [...(users.get(k) || []), a])));
  const note = (a: KeyAction, k: string) => {
    const other = (users.get(k) || []).filter(b => b.id !== a.id && (b.ctx === a.ctx || b.ctx === 'app' || a.ctx === 'app'));
    const same = other.filter(b => b.ctx === a.ctx);
    if (same.length) return { warn: true, text: `Also set for “${same[0].label}”. Only one of them runs.` };
    if (other.length) return { warn: false, text: a.ctx === 'app' ? `On the ${CTX_NAME[other[0].ctx]} it does “${other[0].label}” instead.` : `Takes the place of “${other[0].label}” here.` };
    if (/^Ctrl\+(Shift\+)?Key/.test(k)) return { warn: true, text: 'Control + letter is also a terminal key. The terminal does not get it.' };
    return null;
  };
  let last = '';
  return <>
    <h3 className="set-h">Keyboard shortcuts</h3>
    <p className="sub">Keys with ⌘ or ⌃ work everywhere, also while you type in a terminal. Every ⌃⌥ key goes to Taskboard and not to the terminal. A key without ⌘ or ⌃ works only when the cursor is not in a terminal or a text field. Saved for this app or browser.</p>
    <div className="ctl-box">
      <table className="keys keyset"><tbody>{ACTIONS.map(a => {
        const head = CTX_NAME[a.ctx] !== last; last = CTX_NAME[a.ctx];
        const notes = keysOf(a.id).map(k => [k, note(a, k)] as const).filter(([, n]) => n);
        return <tr key={a.id} className={head ? 'first' : ''}>
          <td className="sub">{head ? CTX_NAME[a.ctx] : ''}</td>
          <td>{a.label}{notes.map(([k, n]) => <div key={k} className={`keynote ${n!.warn ? 'warn' : ''}`}>{fmtCombo(k)}: {n!.text}</div>)}</td>
          <td className="keycell">
            {keysOf(a.id).map(k => <span key={k} className="keychip"><kbd>{fmtCombo(k)}</kbd><button title="Remove this key" onClick={() => setKeys(a.id, keysOf(a.id).filter(x => x !== k))}>×</button></span>)}
            {adding === a.id ? <span className="keywait">Press a key… (Esc cancels)</span> : <button className="btn ghost keyadd" title="Add a key: click, then press the key" onClick={() => setAdding(a.id)}>＋</button>}
            {isCustom(a.id) && <button className="btn ghost keyadd" title={`Back to ${a.keys.map(fmtCombo).join(' / ') || 'no key'}`} onClick={() => resetKeys(a.id)}>Reset</button>}
          </td>
        </tr>;
      })}</tbody></table>
      <div><button className="btn" disabled={!ACTIONS.some(a => isCustom(a.id))} onClick={() => resetKeys()}>Reset all keys</button></div>
    </div>
  </>;
}
