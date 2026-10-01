// The Integrations section of the Settings page: one card for each sign-in that Taskboard uses. A new integration
// adds its own card here. The Inbox tabs show the messages and link here when a connection is missing.
import { useEffect, useState } from 'react';
import { request as mailRequest } from './Mail';
import { request as a2aRequest, type Status } from './A2ANotes';

function useAction(load: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setError(''); try { await fn(); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return { busy, error, act };
}

// Taskboard messages (server/mail): the Slack account that sends and receives Taskboard messages.
function SlackMessagesCard() {
  const [identity, setIdentity] = useState<{ user: string; name?: string; needsReconnect?: boolean } | null | undefined>(undefined);
  const [signInError, setSignInError] = useState('');
  const load = async () => { const d = await mailRequest(''); setIdentity(d.identity); setSignInError(d.error || ''); };
  const { busy, error, act } = useAction(load);
  useEffect(() => { void load().catch(() => {}); }, []);
  return <div className="ctl-box">
    <b>Taskboard messages (Slack)</b>
    <div className="sub">Sends and reads Taskboard messages in your Slack direct conversations. The messages are on the Inbox page, in Messages and Sent.</div>
    <div>{identity === undefined ? 'Loading…' : identity ? `Connected as ${identity.name || identity.user}.` : 'Not connected.'}</div>
    {identity?.needsReconnect && <div role="alert">Reconnect Slack to grant the current permissions. Disconnect Slack, then connect it again.</div>}
    {(error || signInError) && <div role="alert">{error || signInError}</div>}
    <div><button className="btn" disabled={busy || identity === undefined} onClick={() => act(async () => {
      if (identity) await mailRequest('/slack/disconnect', {});
      else location.assign((await mailRequest('/slack/connect', {})).url);
    })}>{identity ? 'Disconnect Slack' : 'Connect Slack'}</button></div>
  </div>;
}

// A2A Notes (server/a2anotes): setup of the separate service, and its own Slack sign-in.
function A2ANotesCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const load = async () => setStatus(await a2aRequest('/status'));
  const { busy, error, act } = useAction(load);
  useEffect(() => { void load().catch(() => {}); const timer = setInterval(() => { void load().catch(() => {}); }, 15_000); return () => clearInterval(timer); }, []);
  const s = status?.setup, c = status?.connection;
  const setup = () => act(() => a2aRequest('/setup', {}));
  return <div className="ctl-box">
    <b>A2A Notes (Slack)</b>
    <div className="sub">Sends messages between people and their agents over Slack, also to people who do not use Taskboard. It runs as its own service on this computer and has its own Slack sign-in. The messages are on the Inbox page, in A2A Notes.</div>
    {!status ? <div>Loading…</div> : <>
      <div>{!status.enabled ? 'Not set up.'
        : status.error ? `Not reachable: ${status.error}`
        : c?.signed_in ? `Connected as ${status.identity?.name}. Last scan: ${c.last_scan_at ? new Date(c.last_scan_at).toLocaleString() : 'never'}.`
        : 'Running. Connect Slack to send and receive messages.'}</div>
      {s && !s.installed && <div role="alert">A2A Notes is not installed with this Taskboard. Run pnpm install in the Taskboard folder.</div>}
      {c?.last_error && <div role="alert">Last scan error: {c.last_error}</div>}
      {!!c?.missing_scopes.length && <div role="alert">Missing Slack scopes: {c.missing_scopes.join(', ')}</div>}
      {s?.updateAvailable && <div>Version {s.version} is installed. The running service is version {s.serviceVersion}. Restart it to use the new version.</div>}
      {!status.enabled && s?.installed && <div className="sub">Setup writes the A2A Notes settings in {s.folder}, starts the service{s.running ? ' (it is already running)' : ''}, keeps it running after you sign in to this computer, and connects Taskboard to it.</div>}
      {error && <div role="alert">{error}</div>}
      <div className="mail-tabs">
        {!status.enabled && <button className="btn" disabled={busy || !s?.installed} onClick={setup}>{busy ? 'Setting up…' : 'Set up A2A Notes'}</button>}
        {status.enabled && status.error && s && !s.running && <button className="btn" disabled={busy} onClick={setup}>{busy ? 'Starting…' : 'Start A2A Notes'}</button>}
        {s?.updateAvailable && <button className="btn" disabled={busy} onClick={setup}>{busy ? 'Restarting…' : 'Restart A2A Notes'}</button>}
        {status.enabled && !status.error && !c?.signed_in && <button className="btn" disabled={busy} onClick={() => act(async () => location.assign((await a2aRequest('/slack-sign-in', {})).url))}>Connect Slack</button>}
      </div>
    </>}
  </div>;
}

export function Integrations() {
  return <>
    <h3 className="set-h">Integrations</h3>
    <p className="sub">The sign-ins that Taskboard uses. Each integration has its own card.</p>
    <SlackMessagesCard />
    <A2ANotesCard />
  </>;
}
