import { useEffect, useState } from 'react';
import { api, type DecisionOrigin, type Permit } from '../api';
import type { CardGuard } from '../clickGuard';
import { permitHeadline, stepWord } from '../permitText';
import { PermitSettings } from './PermitSettings';

// guard: the click rules of the approval card that shows this permit (clickGuard.ts). newCard: true while Deny needs a second click.
export function PermitDetails({ id, decision = false, openTask, guard, newCard }: { id: string; decision?: boolean; openTask?: (id: string) => void; guard?: CardGuard; newCard?: () => boolean }) {
  const [permit, setPermit] = useState<Permit | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const load = () => api.permit(id).then(setPermit).catch(e => setError(String(e.message || e)));
    void load(); const timer = setInterval(load, 2000); return () => clearInterval(timer);
  }, [id]);
  const decide = async (approve: boolean, origin?: DecisionOrigin) => {
    setBusy(true); setError('');
    try { setPermit(await api.decidePermit(id, approve, comment, origin)); }
    catch (e) { setError(String((e as Error).message || e)); }
    setBusy(false);
  };
  if (!permit) return <div className="approval">{error || 'Loading permit…'}</div>;
  const head = permitHeadline(permit);
  return <div className={`approval permit-${permit.state}`}>
    <div className="ap-h"><span className={`dot ${permit.state === 'pending' ? 'needs-you' : permit.state === 'succeeded' ? 'unread' : 'stopped'}`} /><b>Task #{permit.taskNum} · {head.state}</b><span className="sub">Permit {permit.id.slice(0, 8)}</span></div>
    <p>{permit.reason}</p>
    {permit.statedRisk && <p>Risk: {permit.statedRisk}</p>}
    {permit.stepHash && <div className="sub">Approved steps SHA-256: {permit.stepHash}</div>}
    {permit.expiresAt && <div className="sub">Expires: {permit.expiresAt}</div>}
    <div className="sub">Owner: {permit.taskId} · Agent: {permit.agent} · Risk class: {permit.riskClass || 'unknown'}{head.when ? ` · ${head.when}` : ''} · {permit.riskFlags.length ? permit.riskFlags.join(' · ') : 'No risk flags'}</div>
    {permit.supervised && <div className="sub">Process: {permit.supervised.name} · Runs once · No execution timeout · Stop: tb proc stop {permit.supervised.name}</div>}
    <ol>{permit.steps.map((step, i) => <li key={i}><b>{stepWord(step.state)}</b><pre className="ap-d"><code>{step.command}</code></pre><div className="sub">Folder: {step.cwd} · {permit.supervised ? 'No execution timeout' : `${step.timeoutSeconds} s`} · Network: {step.network ? 'Yes' : 'No'}</div><PermitSettings step={step} />{step.scriptHash && <div className="sub">Script SHA-256: {step.scriptHash}</div>}{step.exitCode !== undefined && <div>Exit code: {step.exitCode ?? 'none'}</div>}{step.error && <div className="banner">{step.error}</div>}{step.outputTail && <pre className="ap-d">{step.outputTail}</pre>}</li>)}</ol>
    {permit.approvedBy && <div className="sub">Approved by {permit.approvedBy} · Rule: {permit.approvalRule || 'none'}{permit.controllerRequestText ? ` · User request: ${permit.controllerRequestText}` : ''}</div>}
    {permit.decisionComment && <div className="sub">Comment: {permit.decisionComment}</div>}
    {head.note ? <div className="pc-note info">{head.note}</div> : permit.error && <div className="banner">{permit.error}</div>}
    {error && <div className="banner">{error}</div>}
    {decision && head.open && <><textarea className="routing-rule" rows={2} aria-label="Permit decision comment" placeholder="Optional comment for the task" value={comment} onChange={e => setComment(e.target.value)} />{guard
      ? <div className="ap-a"><button disabled={busy} {...guard.button('approve', o => void decide(true, o), { className: 'btn primary' })}>Run</button><button className="btn" onClick={() => void navigator.clipboard.writeText(permit.steps.map(s => s.command).join('\n'))}>Copy</button><button disabled={busy} {...guard.button('deny', o => void decide(false, o), { confirm: newCard })}>{guard.confirming === 'deny' ? 'Confirm deny' : 'Deny'}</button>{openTask && <button {...guard.button('open', () => openTask(permit.taskId), { className: 'btn ghost' })}>Open task</button>}</div>
      : <div className="ap-a"><button className="btn primary" disabled={busy} onClick={() => void decide(true, { from: 'permits', target: 'approve' })}>Run</button><button className="btn" onClick={() => void navigator.clipboard.writeText(permit.steps.map(s => s.command).join('\n'))}>Copy</button><button className="btn" disabled={busy} onClick={() => void decide(false, { from: 'permits', target: 'deny' })}>Deny</button>{openTask && <button className="btn ghost" onClick={() => openTask(permit.taskId)}>Open task</button>}</div>}</>}
  </div>;
}

export function PermitsPage({ openTask }: { openTask: (id: string) => void }) {
  const [items, setItems] = useState<Permit[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const load = () => api.permits().then(setItems).catch(e => setError(String(e.message || e)));
    void load(); const timer = setInterval(load, 3000); return () => clearInterval(timer);
  }, []);
  return <div className="acc-page"><div className="acc-head"><div><h2>Permits</h2><p>Past requests and step results on this machine.</p></div></div>{error && <div className="banner">{error}</div>}{items.length ? items.map(p => <PermitDetails key={p.id} id={p.id} decision={p.state === 'pending'} openTask={openTask} />) : <p className="sub">No permit requests yet.</p>}</div>;
}
