import { useEffect, useState } from 'react';

interface Settings { enabled: boolean; kinds: string[]; dangerous: string[]; kindsAvailable: string[]; warnings: Record<string, string> }
interface Decision { at: string; group: string; manager: string; card: string | null; kind: string; task: string; head: string | null; decision: string; reason: string; state: string }
async function request(path: string, body?: unknown) {
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request failed.');
  return data;
}

export function DelegationSettings({ group }: { group: string }) {
  const [settings, setSettings] = useState<Settings>();
  const [rows, setRows] = useState<Decision[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const path = `/api/delegation/${encodeURIComponent(group)}`;
  const load = async () => {
    const [value, record] = await Promise.all([request(path), request(`/api/delegation/audit?group=${encodeURIComponent(group)}`)]);
    setSettings(value); setRows(record.reverse());
  };
  useEffect(() => { void load().catch(e => setError(e.message)); }, [group]);
  const save = async (all = false, off = false) => {
    if (!settings) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await request(all ? '/api/delegation/revoke-all' : path, all ? {} : { ...settings, enabled: off ? false : settings.enabled, confirmDangerous: true });
      await load(); setNotice(all ? 'Delegation is off for all groups.' : off ? 'Delegation is off for this group.' : 'Delegation settings saved.');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const select = (field: 'kinds' | 'dangerous', value: string, checked: boolean) => {
    if (!settings) return;
    if (field === 'dangerous' && checked && !window.confirm(settings.warnings[value])) return;
    setSettings({ ...settings, [field]: checked ? [...settings[field], value] : settings[field].filter(v => v !== value) });
  };
  if (!settings) return <div className="sub">{error || 'Loading delegation settings…'}</div>;
  return <details className="delegation-settings">
    <summary>Manager delegation {settings.enabled ? '(on)' : '(off)'}</summary>
    <p>Only you can change these settings. A task message or log entry never gives approval.</p>
    <label><input type="checkbox" checked={settings.enabled} disabled={busy} onChange={e => setSettings({ ...settings, enabled: e.target.checked })} /> Allow manager card decisions for this group</label>
    <fieldset disabled={busy}><legend>Card kinds</legend>
      {settings.kindsAvailable.map(kind => <label key={kind} style={{ display: 'block' }}>
        <input type="checkbox" checked={settings.kinds.includes(kind)} onChange={e => select('kinds', kind, e.target.checked)} /> {kind}
      </label>)}
    </fieldset>
    <fieldset disabled={busy}><legend>Separate dangerous switches</legend>
      {Object.entries(settings.warnings).map(([kind, warning]) => <label key={kind} style={{ display: 'block', marginBottom: 8 }}>
        <input type="checkbox" checked={settings.dangerous.includes(kind)} onChange={e => select('dangerous', kind, e.target.checked)} /> {kind}
        <small style={{ display: 'block' }}>{warning}</small>
      </label>)}
    </fieldset>
    <div className="row">
      <button className="btn" disabled={busy} onClick={() => void save()}>Save delegation</button>
      <button className="btn danger" disabled={busy} onClick={() => void save(false, true)}>Turn off this group</button>
      <button className="btn danger" disabled={busy} onClick={() => void save(true)}>Turn off all groups</button>
    </div>
    <p>Revocation stops new decisions immediately. Actions that already started can finish.</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <details><summary>Manager decision record ({rows.length})</summary>
      <button className="btn" onClick={() => void load().catch(e => setError(e.message))}>Refresh record</button>
      {!rows.length && <p>No manager decisions recorded.</p>}
      {rows.map((row, i) => <div key={i} style={{ borderTop: '1px solid var(--border)', padding: 8, overflowWrap: 'anywhere' }}>
        <div>{row.at}</div><div>Group: {row.group}</div><div>Manager: {row.manager}</div>
        <div>Card: {row.card || 'none'}</div><div>Kind: {row.kind}</div><div>Task: {row.task}</div>
        <div>Branch head: {row.head || 'No branch'}</div><div>Decision: {row.decision}</div>
        <div>Reason: {row.reason}</div><div>State: {row.state}</div>
      </div>)}
    </details>
  </details>;
}
