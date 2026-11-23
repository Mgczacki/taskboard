// The banner shows who turned on urgent mode and which actions still need the user.
import { useState } from 'react';
import type { Task } from '../api';
import { api } from '../api';

export function UrgentBanner({ t, act }: { t: Task; act: (p: Promise<unknown>) => void }) {
  if (!t.urgent) return null;
  return <div className="banner urgent" role="status">
    <div style={{ flex: '1 1 100%' }}><b>Urgent mode is on.</b> Taskboard auto-approves eligible new cards and removes request limits. Protected operations still need a user decision.
      <ul><li>Opening or merging pull requests.</li><li>Force pushes.</li><li>Taskboard releases and rollbacks.</li><li>Taskboard restarts.</li></ul>
      Mail follows its Permissions setting. Questions still need an answer.</div>
    <span className="sub">Turned on by the {t.urgent.by} at {new Date(t.urgent.startedAt).toLocaleString()}. Reason: {t.urgent.reason}</span>
    <button className="btn danger" onClick={() => act(api.urgent(t.id, false, 'Turned off on the dashboard.'))} title="The Taskboard restrictions apply again at once">Turn off urgent mode</button>
  </div>;
}

export function UrgentButton({ t, act }: { t: Task; act: (p: Promise<unknown>) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (t.urgent || t.role === 'controller' || t.status === 'archived' || t.machine) return null;
  if (!open) return <button className="btn" onClick={() => setOpen(true)} title="Auto-approve eligible new cards and remove request limits for this task">Urgent mode…</button>;
  return <span className="urgent-form">
    <span className="sel-warn">Urgent mode auto-approves eligible new cards for #{t.num} until you turn it off. Protected operations still need a user decision.</span>
    <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason (required)" maxLength={500} aria-label="Reason for urgent mode" />
    <button className="btn danger" disabled={!reason.trim()} onClick={() => { act(api.urgent(t.id, true, reason.trim())); setOpen(false); setReason(''); }}>Turn on</button>
    <button className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
  </span>;
}

export const UrgentBadge = ({ t }: { t: Task }) => t.urgent
  ? <span className="urgent-badge" title={`Urgent mode: eligible new cards are auto-approved. Turned on by the ${t.urgent.by}. ${t.urgent.reason}`}>URGENT</span> : null;
