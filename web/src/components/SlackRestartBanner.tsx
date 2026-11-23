import { useEffect, useState } from 'react';
import { request as a2aRequest, type Status } from './A2ANotes';

// Shows in the main view when A2A Notes cannot reach Slack Desktop. Slack then usually runs without its debugging port,
// for example after a Slack update, a reboot, or a manual restart. The button asks A2A Notes to restart Slack with the port.
export function SlackRestartBanner() {
  const [status, setStatus] = useState<Status | null>(null);
  const [closed, setClosed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const load = () => a2aRequest('/status').then((s: Status) => { setStatus(s); if (s.connection?.desktop?.connected) setClosed(false); }).catch(() => {});
  useEffect(() => { void load(); const timer = setInterval(load, 30_000); return () => clearInterval(timer); }, []);
  const c = status?.connection;
  if (closed || !status?.enabled || status.error || !c?.signed_in || !c.desktop || c.desktop.connected) return null;
  const restart = async () => {
    if (!window.confirm('Quit Slack and start it again for A2A Notes? Slack keeps unsent drafts.')) return;
    setBusy(true); setError('');
    try { await a2aRequest('/restart-slack', {}); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Slack did not restart.'); }
    finally { setBusy(false); }
  };
  return <div className="server-bar away" role="alert">
    <div>A2A Notes cannot reach Slack Desktop. Slack probably started without its debugging port. Slack messages wait until it is reachable.
      {error && <div>{error}</div>}</div>
    <button className="btn" disabled={busy} onClick={() => void restart()}>{busy ? 'Restarting Slack…' : 'Restart Slack for A2A Notes'}</button>
    <button className="btn ghost" onClick={() => setClosed(true)}>Close</button>
  </div>;
}
