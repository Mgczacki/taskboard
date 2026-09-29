// Settings: what the controller and other agents may do without asking, and this machine's controller.
import { useEffect, useState } from 'react';
import type { MachineInfo, Task } from '../api';
import { api, autoReload, setAutoReload } from '../api';
import { ControllerBox, loadAccounts } from './Accounts';
import type { Account } from './Accounts';

export function SettingsPage({ tasks }: { tasks: Task[] }) {
  const [info, setInfo] = useState<MachineInfo | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [reloadOn, setReloadOn] = useState(autoReload());
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
      <p className="sub">Starting tasks, typing into them, setting them aside and archiving them with <code>tb</code> can run at once or wait for your Approve / Deny card on the dashboard. Neither Claude Code nor Codex asks separately for <code>tb</code> commands of the controller; this is the one place that decides.</p>
      {p && <div className="ctl-box">
        <label className="opt" title="When on, the controller's tb new / send / park / archive run immediately"><input type="checkbox" disabled={busy} checked={!p.controllerNeedsApproval} onChange={e => save({ controllerNeedsApproval: !e.target.checked })} /> <b>The controller may create and manage tasks without asking</b></label>
        <label className="opt" title="Agents other than the controller that use tb to start or type into tasks"><input type="checkbox" disabled={busy} checked={!p.agentsNeedApproval} onChange={e => save({ agentsNeedApproval: !e.target.checked })} /> Other agents may start, type into, set aside and archive tasks without asking</label>
        <div className="sub">A change reaches the controller when it next restarts, which Taskboard does by itself as soon as the controller is between turns (its conversation continues). Releasing or rolling back Taskboard and stopping its server stay blocked for every agent.</div>
      </div>}
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
