import { useEffect, useState } from 'react';
import { api, linkedTaskId, type Task, type TransferCheck } from '../api';

export function TransferPanel({ task, close, openTarget }: { task: Task; close: () => void; openTarget: (id: string) => void }) {
  const [machines, setMachines] = useState<{ id: string; name: string; online: boolean }[]>([]);
  const [machine, setMachine] = useState('');
  const [folder, setFolder] = useState(task.cwd);
  const [check, setCheck] = useState<TransferCheck | null>(null);
  const [account, setAccount] = useState('');
  const [includeFiles, setIncludeFiles] = useState(true);
  const [includeWorkspace, setIncludeWorkspace] = useState(true);
  const [includeTranscript, setIncludeTranscript] = useState(false);
  const [handoffOnly, setHandoffOnly] = useState(false);
  const [useBundle, setUseBundle] = useState(false);
  const [stopNow, setStopNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ id: string; num: number; machine: string; machineIdentity?: string } | null>(null);
  useEffect(() => { api.transferMachines(task.id).then(setMachines).catch(e => setError(String(e.message || e))); }, [task.id]);
  const inspect = async () => {
    setBusy(true); setError(''); setCheck(null);
    try {
      const report = await api.transferCheck(task.id, machine, folder);
      setHandoffOnly(false); setUseBundle(false); setIncludeWorkspace(true); setIncludeTranscript(false);
      setCheck(report);
      setAccount(report.accounts.find(a => a.agent === task.agent && a.signedIn && !a.unavailable)?.id || '');
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { setBusy(false); }
  };
  const move = async () => {
    if (!check) return;
    setBusy(true); setError('');
    try {
      const moved = await api.transferMove(task.id, { machine, folder: check.folder, account, fingerprint: check.fingerprint, handoffOnly, useBundle, includeFiles, includeWorkspace, includeTranscript, stopNow });
      setResult(moved);
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { setBusy(false); }
  };
  const selected = check?.accounts.find(a => a.id === account);
  return <div className="banner" style={{ display: 'block' }}>
    <b>Move to another machine</b>
    {result ? <p>Task #{result.num} started on {machines.find(m => m.id === result.machine)?.name || result.machine}. <button className="btn" onClick={() => void linkedTaskId(result.machineIdentity, result.id).then(id => id ? openTarget(id) : setError('The target machine is not paired with this dashboard.')).catch(e => setError(String(e.message || e)))}>Open target</button></p>
      : <>
        <div className="field"><label>Target machine</label><select value={machine} disabled={busy} onChange={e => { setMachine(e.target.value); setCheck(null); }}><option value="">Choose a machine</option>{machines.map(m => <option key={m.id} value={m.id} disabled={!m.online}>{m.name}{m.online ? '' : ' · offline'}</option>)}</select></div>
        <div className="field"><label>Existing target folder or worktree</label><input value={folder} disabled={busy} onChange={e => { setFolder(e.target.value); setCheck(null); }} /></div>
        <button className="btn" disabled={!machine || !folder || busy} onClick={() => void inspect()}>{busy ? 'Checking…' : 'Check transfer'}</button>
        {check && <div>
          <p>Source: <code>{check.source.branch || 'no Git branch'}</code> at <code>{check.source.head.slice(0, 12) || 'no commit'}</code>. Target: <code>{check.target.branch || 'no Git branch'}</code> at <code>{check.target.head.slice(0, 12) || 'no commit'}</code>.</p>
          <p>Git remote: <code>{check.source.remote || 'missing'}</code>. Target remote: <code>{check.target.remote || 'missing'}</code>.</p>
          <p>Changed source files: {check.source.changes.length}. Ignored source files: {check.source.ignored.length}. Target changes: {check.target.changes.length}.</p>
          {check.issues.length > 0 && <ul>{check.issues.map((item, i) => <li key={i}>{item}</li>)}</ul>}
          {check.workspace.omitted.length > 0 && <ul>{check.workspace.omitted.map((item, i) => <li key={i}>{item}</li>)}</ul>}
          {check.files.omitted.length > 0 && <ul>{check.files.omitted.map((item, i) => <li key={i}>{item}</li>)}</ul>}
          {!check.ready && check.bundle?.available && <label className="opt"><input type="checkbox" checked={useBundle} onChange={e => { setUseBundle(e.target.checked); if (e.target.checked) { setHandoffOnly(false); setIncludeWorkspace(true); } }} /> Copy {check.bundle.commits} commits in a Git bundle ({check.bundle.size} bytes). The target gets a new worktree.</label>}
          {!check.ready && check.bundle && !check.bundle.available && <p>Git bundle unavailable: {check.bundle.reason}</p>}
          {!check.ready && <label className="opt"><input type="checkbox" checked={handoffOnly} onChange={e => { setHandoffOnly(e.target.checked); if (e.target.checked) { setUseBundle(false); setIncludeWorkspace(false); } }} /> Start from this target folder with a handoff. The target may lack source commits and project files.</label>}
          {!check.ready && <p>You can also push the source branch through Taskboard's push approval, pull it on the target, and check again.</p>}
          <div className="field"><label>Target account</label><select value={account} disabled={busy} onChange={e => setAccount(e.target.value)}><option value="">Choose an account</option>{check.accounts.filter(a => a.agent === task.agent).map(a => <option key={a.id} value={a.id} disabled={!a.signedIn || !!a.unavailable}>{a.name}{!a.signedIn ? ' · sign in on target' : a.unavailable ? ` · ${a.unavailable}` : ''}</option>)}</select></div>
          <label className="opt"><input type="checkbox" checked={includeFiles} onChange={e => setIncludeFiles(e.target.checked)} /> Copy {check.files.files.length} task files. The list includes the log, inbox, and outbox.</label>
          {check.files.files.length > 0 && <details><summary>Task files</summary><ul>{check.files.files.map(f => <li key={f.path}>{f.path} ({f.size} bytes)</li>)}</ul></details>}
          <label className="opt"><input type="checkbox" checked={includeWorkspace} disabled={handoffOnly} onChange={e => setIncludeWorkspace(e.target.checked)} /> Copy {check.workspace.files.length} changed project files.</label>
          {check.workspace.files.length > 0 && <details><summary>Changed project files</summary><ul>{check.workspace.files.map(f => <li key={f.path}>{f.path} ({f.size} bytes)</li>)}</ul></details>}
          {check.transcript && <label className="opt"><input type="checkbox" checked={includeTranscript} disabled={!check.transcript.available} onChange={e => setIncludeTranscript(e.target.checked)} /> Copy the earlier transcript as a task file ({check.transcript.size} bytes). {check.transcript.reason || 'The target starts a new conversation.'}</label>}
          {task.status === 'working' && <label className="opt"><input type="checkbox" checked={stopNow} onChange={e => setStopNow(e.target.checked)} /> Stop the current turn now. Any running command can stop before it finishes.</label>}
          <p>The target starts a new conversation from a handoff. The source task stays archived with a link. Credentials and ignored files stay on this machine.</p>
          <button className="btn primary" disabled={busy || (!check.ready && !handoffOnly && !useBundle) || !selected?.signedIn || !!selected.unavailable || (task.status === 'working' && !stopNow) || (includeWorkspace && check.workspace.omitted.length > 0)} onClick={() => void move()}>Approve transfer</button>
        </div>}
      </>}
    {error && <p className="sel-warn">{error}</p>}
    <button className="btn ghost" disabled={busy} onClick={close}>Close</button>
  </div>;
}
