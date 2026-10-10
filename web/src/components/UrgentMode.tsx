// Urgent mode of one task (server/urgent.ts): while it is on, Taskboard does not restrict the task. Only the user (here,
// on the dashboard) or the controller turns it on or off. The banner shows that it is on, by whom, and why.
import { useState } from 'react';
import type { Task } from '../api';
import { api } from '../api';

export function UrgentBanner({ t, act }: { t: Task; act: (p: Promise<unknown>) => void }) {
  if (!t.urgent) return null;
  return <div className="banner urgent" role="status">
    <div style={{ flex: '1 1 100%' }}><b>Urgent mode is on.</b> Taskboard does not restrict this task: the guard allows every shell command, and Taskboard approves each card of this task at once (permits, scope, merges, pushes, pull requests, releases, messages to tasks). Message drafts to people still wait for you.</div>
    <span className="sub">Turned on by the {t.urgent.by} at {new Date(t.urgent.startedAt).toLocaleString()}. Reason: {t.urgent.reason}</span>
    <button className="btn danger" onClick={() => act(api.urgent(t.id, false, 'Turned off on the dashboard.'))} title="The Taskboard restrictions apply again at once">Turn off urgent mode</button>
  </div>;
}

export function UrgentButton({ t, act }: { t: Task; act: (p: Promise<unknown>) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (t.urgent || t.role === 'controller' || t.status === 'archived' || t.machine) return null;
  if (!open) return <button className="btn" onClick={() => setOpen(true)} title="Turn off every Taskboard restriction of this task until you turn it off">Urgent mode…</button>;
  return <span className="urgent-form">
    <span className="sel-warn">Urgent mode removes every Taskboard restriction of #{t.num} until you turn it off: Git writes and pushes, releases, scope, permits and messages to tasks run without cards.</span>
    <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason (required)" maxLength={500} aria-label="Reason for urgent mode" />
    <button className="btn danger" disabled={!reason.trim()} onClick={() => { act(api.urgent(t.id, true, reason.trim())); setOpen(false); setReason(''); }}>Turn on</button>
    <button className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
  </span>;
}

export const UrgentBadge = ({ t }: { t: Task }) => t.urgent
  ? <span className="urgent-badge" title={`Urgent mode: no Taskboard restrictions. Turned on by the ${t.urgent.by}. ${t.urgent.reason}`}>URGENT</span> : null;
