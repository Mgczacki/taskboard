import { useEffect, useState } from 'react';
import { api, type Permit } from '../api';

export function PermitDetails({ id, decision = false, openTask }: { id: string; decision?: boolean; openTask?: (id: string) => void }) {
  const [permit, setPermit] = useState<Permit | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const load = () => api.permit(id).then(setPermit).catch(e => setError(String(e.message || e)));
    void load(); const timer = setInterval(load, 2000); return () => clearInterval(timer);
  }, [id]);
  const decide = async (approve: boolean) => {
    setBusy(true); setError('');
    try { setPermit(await api.decidePermit(id, approve, comment)); }
    catch (e) { setError(String((e as Error).message || e)); }
    setBusy(false);
  };
  if (!permit) return <div className="approval">{error || 'Loading permit…'}</div>;
  return <div className={`approval permit-${permit.state}`}>
    <div className="ap-h"><span className={`dot ${permit.state === 'pending' ? 'needs-you' : permit.state === 'succeeded' ? 'unread' : 'stopped'}`} /><b>Task #{permit.taskNum} · {permit.state}</b><span className="sub">Permit {permit.id.slice(0, 8)}</span></div>
    <p>{permit.reason}</p>
    <div className="sub">Expires {new Date(permit.expiresAt).toLocaleString()} · {permit.riskFlags.length ? permit.riskFlags.join(' · ') : 'No risk flags'}</div>
    <ol>{permit.steps.map((step, i) => <li key={i}><b>{step.state}</b> <code>{step.command}</code><div className="sub">{step.cwd} · {step.timeoutSeconds} s · Network: {step.network ? 'Yes' : 'No'}</div>{step.error && <div className="banner">{step.error}</div>}{step.outputTail && <pre className="ap-d">{step.outputTail}</pre>}</li>)}</ol>
    {permit.approvedBy && <div className="sub">Approved by {permit.approvedBy}{permit.controllerRequestText ? ` · User request: ${permit.controllerRequestText}` : ''}</div>}
    {permit.decisionComment && <div className="sub">Comment: {permit.decisionComment}</div>}
    {permit.error && <div className="banner">{permit.error}</div>}
    {error && <div className="banner">{error}</div>}
    {decision && permit.state === 'pending' && <><textarea className="routing-rule" rows={2} aria-label="Permit decision comment" placeholder="Comment for the task" value={comment} onChange={e => setComment(e.target.value)} /><div className="ap-a"><button className="btn primary" disabled={busy} onClick={() => void decide(true)}>Approve sequence</button><button className="btn" disabled={busy} onClick={() => void decide(false)}>Deny</button>{openTask && <button className="btn ghost" onClick={() => openTask(permit.taskId)}>Open task</button>}</div></>}
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
