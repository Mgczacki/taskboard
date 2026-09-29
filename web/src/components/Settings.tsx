// Settings: what the controller and other agents may do without asking, and this machine's controller.
import { useEffect, useState } from 'react';
import type { MachineInfo, Task } from '../api';
import { api, autoReload, confirmEnd, setAutoReload, setConfirmEnd } from '../api';
import { ControllerBox } from './Accounts';

export function SettingsPage({ tasks }: { tasks: Task[] }) {
  const [info, setInfo] = useState<MachineInfo | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [reloadOn, setReloadOn] = useState(autoReload());
  const [askEnd, setAskEnd] = useState(confirmEnd());
  useEffect(() => { api.info().then(setInfo).catch(e => setErr(String(e.message || e))); }, []);
  const save = async (p: { controllerNeedsApproval?: boolean; agentsNeedApproval?: boolean }) => {
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
      <h3 className="set-h">Canvas</h3>
      <div className="ctl-box">
        <label className="opt" title="The ⏻ button in a canvas window's header ends the tmux session and archives the task"><input type="checkbox" checked={askEnd} onChange={e => { setConfirmEnd(e.target.checked); setAskEnd(e.target.checked); }} /> Ask before ⏻ in a window header ends and archives the task</label>
        <div className="sub">Saved for this app or browser. When it is off, ⏻ acts at once and a message offers Restore.</div>
      </div>
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
