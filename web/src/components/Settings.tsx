// Settings: what the controller and other agents may do without asking, and this machine's controller.
import { useEffect, useState } from 'react';
import type { MachineInfo, MessageLevel, PushRecord, Task } from '../api';
import { api, autoReload, confirmEnd, setAutoReload, setConfirmEnd } from '../api';
import { ControllerBox, MaxTasksInput, loadAccounts } from './Accounts';
import { MessageLevels } from './MessageLevels';
import { Integrations } from './Integrations';
import { RulesFiles } from './RulesFiles';
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
  const [routingRules, setRoutingRules] = useState('');
  const [applyAll, setApplyAll] = useState(false); // the confirmation for "Apply to all accounts" is open
  const [permitFolders, setPermitFolders] = useState('');
  const [confirmPermits, setConfirmPermits] = useState(false);
  const [pushes, setPushes] = useState<PushRecord[]>([]);
  const [ownRepositories, setOwnRepositories] = useState('');
  const [protectedBranches, setProtectedBranches] = useState('');
  useEffect(() => { api.info().then(i => { setInfo(i); setRoutingRules(i.settings.routingRules || ''); setPermitFolders((i.settings.permitFolders || []).join('\n')); setOwnRepositories((i.settings.pushes?.ownRepositories || []).join('\n')); setProtectedBranches((i.settings.pushes?.protectedBranches || []).join('\n')); }).catch(e => setErr(String(e.message || e))); loadAccounts().then(setAccts).catch(() => {}); api.pushes().then(setPushes).catch(() => {}); }, []);
  const save = async (p: { routingRules?: string; controllerNeedsApproval?: boolean; agentsNeedApproval?: boolean; trustWorkspaces?: boolean; autoReview?: boolean; controllerCanApprovePermits?: boolean; permitFolders?: string[]; pushTaskBranches?: 'run' | 'ask' | 'never'; ownRepositories?: string[]; protectedBranches?: string[]; askAgent?: 'claude' | 'codex'; askAccount?: string; askModel?: string; reviewAccount?: string; reviewModel?: string; messageIncoming?: MessageLevel; messageOutgoing?: MessageLevel; checkPrivateNotes?: boolean; confirmLowerControl?: boolean; defaultMaxParallel?: number; applyMaxParallelToAll?: boolean }) => {
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
        <label className="opt" title="When on, the controller's tb new / send / park / archive / resume run immediately"><input type="checkbox" disabled={busy} checked={!p.controllerNeedsApproval} onChange={e => save({ controllerNeedsApproval: !e.target.checked })} /> <b>The controller may create and manage tasks without asking</b></label>
        <label className="opt" title="Agents other than the controller that use tb to start or type into tasks"><input type="checkbox" disabled={busy} checked={!p.agentsNeedApproval} onChange={e => save({ agentsNeedApproval: !e.target.checked })} /> Other agents may start, type into, set aside and archive tasks without asking</label>
        <div className="sub">A change reaches the controller when it next restarts, which Taskboard does by itself as soon as the controller is between turns (its conversation continues). Releasing or rolling back Taskboard and stopping its server stay blocked for every agent.</div>
      </div>}
      {info && <div className="ctl-box"><label className="opt" htmlFor="permit-folders">Extra folders for permit steps</label><textarea id="permit-folders" rows={3} value={permitFolders} onChange={e => setPermitFolders(e.target.value)} placeholder="One absolute path per line" /><div className="sub">A permit card names the working folder. The server runs approved commands in your shell.</div><button className="btn" disabled={busy || permitFolders === (info.settings.permitFolders || []).join('\n')} onClick={() => void save({ permitFolders: permitFolders.split('\n').map(p => p.trim()).filter(Boolean) })}>Save folders</button></div>}
      <h3 className="set-h">Pushes</h3>
      {info && <div className="ctl-box"><label className="opt">Pushes of task branches to my own repositories <select disabled={busy} value={info.settings.pushes.taskBranches === 'never' ? 'never' : 'ask'} onChange={e => void save({ pushTaskBranches: e.target.value as 'ask' | 'never' })}><option value="ask">Ask with a card</option><option value="never">Never</option></select></label><div className="sub">Every push needs your approval on a card. Taskboard checks the signed-in GitHub account.</div><label className="opt" htmlFor="own-repos">Other repositories I own, one owner/repository per line</label><textarea id="own-repos" rows={3} value={ownRepositories} onChange={e => setOwnRepositories(e.target.value)} /><button className="btn" disabled={busy} onClick={() => void save({ ownRepositories: ownRepositories.split('\n').map(s => s.trim()).filter(Boolean) })}>Save repositories</button><label className="opt" htmlFor="protected-branches">Extra protected branches, one per line</label><textarea id="protected-branches" rows={3} value={protectedBranches} onChange={e => setProtectedBranches(e.target.value)} /><button className="btn" disabled={busy} onClick={() => void save({ protectedBranches: protectedBranches.split('\n').map(s => s.trim()).filter(Boolean) })}>Save branches</button><div className="sub">Push history</div>{pushes.length ? pushes.map(item => <div key={item.id} className="sub">{new Date(item.at).toLocaleString()} · {tasks.find(t => t.id === item.taskId)?.title || item.taskId} · {item.remote}/{item.branch} · {item.oldHead?.slice(0, 8) || 'new'} → {item.newHead.slice(0, 8)} · {item.state}{item.result ? ` · ${item.result}` : ''}</div>) : <div className="sub">No pushes yet.</div>}</div>}
      <Integrations />
      <MessageLevels />
      <h3 className="set-h">Agents and accounts</h3>
      {info && <div className="ctl-box">
        <label className="opt">Default maximum tasks per account <MaxTasksInput value={info.settings.accounts.defaultMaxParallel} disabled={busy} label="Default maximum number of tasks for an account you add" onSave={async n => { setInfo(await api.updateInfo({ defaultMaxParallel: n })); }} /></label>
        <div className="sub">An account that you add on the Accounts page starts with this maximum number of running tasks. The accounts that exist now keep their own maximum. Change one account on the Accounts page, or apply this value to all of them.</div>
        {!applyAll
          ? <div><button className="btn" disabled={busy} onClick={() => setApplyAll(true)}>Apply to all accounts…</button></div>
          : <div className="banner">
            <b>Set the maximum of all {accts.length} accounts to {info.settings.accounts.defaultMaxParallel} tasks?</b>
            <span className="sub">Now: {accts.map(a => `${a.name} ${a.maxParallel}`).join(', ')}. Running tasks keep running. When more tasks run on an account than its new maximum, Taskboard refuses new tasks on it until fewer run.</span>
            <button className="btn primary" disabled={busy} onClick={async () => { await save({ applyMaxParallelToAll: true }); setApplyAll(false); loadAccounts().then(setAccts).catch(() => {}); }}>Apply to all accounts</button>
            <button className="btn" onClick={() => setApplyAll(false)}>Cancel</button>
          </div>}
        <div className="sub">Only you can change these maximums, on this page and the Accounts page. <code>tb</code>, agents and the controller cannot.</div>
      </div>}
      <h3 className="set-h">Permit requests</h3>
      {p && <div className="ctl-box">
        <label className="opt"><input type="checkbox" disabled={busy} checked={p.controllerCanApprovePermits} onChange={e => e.target.checked ? setConfirmPermits(true) : void save({ controllerCanApprovePermits: false })} /> The controller may approve low risk suggestions</label>
        <div className="sub">Taskboard checks every step. The controller cannot approve network use, deletion, Git history changes, or commands with unknown effects.</div>
        {confirmPermits && <div className="banner" role="alert"><p>The controller can approve low risk commands on its own judgment. High risk commands need your explicit words in its chat.</p><div className="ap-a"><button className="btn primary" disabled={busy} onClick={() => { void save({ controllerCanApprovePermits: true, confirmLowerControl: true }); setConfirmPermits(false); }}>Allow controller approval</button><button className="btn" onClick={() => setConfirmPermits(false)}>Cancel</button></div></div>}
      </div>}
      <h3 className="set-h">Task routing</h3>
      <div className="ctl-box">
        <label className="opt" htmlFor="routing-rules">Rules for choosing an agent and account</label>
        <textarea id="routing-rules" maxLength={1000} value={routingRules} onChange={e => setRoutingRules(e.target.value)} rows={5} />
        <div className="sub">The controller reads these rules when it starts. A user request can choose an agent or account.</div>
        <button className="btn" disabled={busy || routingRules === info?.settings.routingRules} onClick={() => save({ routingRules })}>Save routing rules</button>
      </div>
      <RulesFiles />
      <h3 className="set-h">Agent sessions</h3>
      {p && <div className="ctl-box">
        <label className="opt"><input type="checkbox" disabled={busy} checked={p.trustWorkspaces} onChange={e => save({ trustWorkspaces: e.target.checked })} /> Trust each task folder before an agent starts</label>
        <label className="opt"><input type="checkbox" disabled={busy} checked={p.autoReview} onChange={e => save({ autoReview: e.target.checked })} /> Review tool requests automatically</label>
        <div className="sub">Claude Code and Codex use their own auto review. Taskboard reviews Antigravity tool calls with the account below. A reviewer can still ask you.</div>
        {info && <>
          <label className="opt">Review account <select disabled={busy || !p.autoReview} value={info.settings.review.account} onChange={e => save({ reviewAccount: e.target.value })}>{accts.filter(a => a.agent === 'claude').map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          <label className="opt">Review model <select disabled={busy || !p.autoReview} value={info.settings.review.model} onChange={e => save({ reviewModel: e.target.value })}><option value="sonnet">Sonnet</option><option value="opus">Opus</option></select></label>
        </>}
        <div className="sub">Claude Code and Codex use these choices when they start or resume. Antigravity uses the current review choice for each tool call. Taskboard keeps the command guard on.</div>
      </div>}
      <h3 className="set-h">Canvas</h3>
      <div className="ctl-box">
        <label className="opt" title="The ⏻ button in a canvas window's header ends the tmux session and archives the task"><input type="checkbox" checked={askEnd} onChange={e => { setConfirmEnd(e.target.checked); setAskEnd(e.target.checked); }} /> Ask before ⏻ in a window header ends and archives the task</label>
        <div className="sub">Saved for this app or browser. When it is off, ⏻ acts at once and a message offers Restore.</div>
      </div>
      <KeySettings />
      <h3 className="set-h">Questions about a session</h3>
      <p className="sub">The <b>?</b> button asks a separate agent about a session. It reads the terminal and transcript. The session's own agent does not see the question. Claude Code questions have a $0.50 limit. Codex questions use the selected account's usage.</p>
      {info && <div className="ctl-box">
        <label className="opt">Agent <select disabled={busy} value={info.settings.ask.agent} onChange={e => save({ askAgent: e.target.value as 'claude' | 'codex' })}>
          <option value="claude">Claude Code</option><option value="codex">Codex</option><option value="antigravity" disabled>Antigravity (read-only access not verified)</option>
        </select></label>
        <label className="opt">Account <select disabled={busy} value={info.settings.ask.account} onChange={e => save({ askAccount: e.target.value })}>{accts.filter(a => a.agent === info.settings.ask.agent).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        {info.settings.ask.agent === 'claude'
          ? <label className="opt">Model <select disabled={busy} value={info.settings.ask.model} onChange={e => save({ askModel: e.target.value })}>{['sonnet', 'haiku', 'opus'].map(m => <option key={m} value={m}>{m[0].toUpperCase() + m.slice(1)}</option>)}</select></label>
          : <label className="opt">Model <input key={info.settings.ask.agent + info.settings.ask.account} disabled={busy} defaultValue={info.settings.ask.model} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} onBlur={e => { const model = e.target.value.trim(); if (model && model !== info.settings.ask.model) save({ askModel: model }); }} /></label>}
        <div className="sub">Antigravity does not offer a verified read-only Ask process with MCP servers disabled.</div>
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
