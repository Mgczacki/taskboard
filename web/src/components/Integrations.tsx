// The Integrations section of the Settings page: one card for each sign-in that Taskboard uses. A new integration
// adds its own card here. The Inbox shows the messages and links here when a connection is missing.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { request as a2aRequest, ServiceVersion, type Status } from './A2ANotes';
import { SettingGroup, SettingItem } from './SettingsLayout';

function useAction(load: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setError(''); try { await fn(); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return { busy, error, act };
}

// The time of the last click on Connect Slack, in this browser tab. When Slack refuses the sign-in (for example
// "redirect_uri did not match any configured URIs"), Slack shows its own page and never returns here. When the user
// comes back and A2A Notes is still not signed in, the card shows the sign-in help from the server (setupState signInHelp).
const SIGN_IN_KEY = 'tb-a2a-slack-sign-in';
const signInStarted = () => { try { return Number(sessionStorage.getItem(SIGN_IN_KEY)) || 0; } catch { return 0; } };
const setSignInStarted = (at: number) => { try { if (at) sessionStorage.setItem(SIGN_IN_KEY, String(at)); else sessionStorage.removeItem(SIGN_IN_KEY); } catch { /* no storage */ } };

// The Slack app of A2A Notes: the app that sign-in uses, the redirect URL it must list, and the Taskboard setting
// (machine.json a2aNotes) that chooses the app for setup.
function SlackAppSettings({ status, busy, apply }: { status: Status; busy: boolean; apply: () => void }) {
  const s = status.setup!;
  const used = s.slack || s.slackApp;
  const [clientId, setClientId] = useState(''), [teamId, setTeamId] = useState(''), [saved, setSaved] = useState({ clientId: '', teamId: '' });
  const [error, setError] = useState('');
  useEffect(() => { void api.info().then(i => { const a = i.settings.a2aNotes || { slackClientId: '', slackTeamId: '' }; setSaved({ clientId: a.slackClientId, teamId: a.slackTeamId }); setClientId(a.slackClientId); setTeamId(a.slackTeamId); }).catch(() => {}); }, []);
  const save = async () => {
    setError('');
    try { const a = (await api.updateInfo({ a2aSlackClientId: clientId.trim(), a2aSlackTeamId: teamId.trim() })).settings.a2aNotes; if (a) setSaved({ clientId: a.slackClientId, teamId: a.slackTeamId }); }
    catch (e) { setError((e as Error).message); }
  };
  const source = { settings: 'the Taskboard setting below', environment: 'TASKBOARD_A2A_SLACK_CLIENT_ID and TASKBOARD_A2A_SLACK_TEAM_ID', default: 'the default' }[s.slackApp.source];
  return <>
    <div className="sub">Slack app: {used.name ? `${used.name}, ` : ''}client ID <code>{used.clientId}</code>, team <code>{used.teamId}</code>{s.slack ? '' : ' (setup writes it)'}. That app must list this redirect URL under OAuth &amp; Permissions, Redirect URLs: <code>{used.redirectUri || s.slackApp.redirectUri}</code></div>
    {s.slackAppDiffers && <div role="alert">The A2A Notes settings in {s.folder} use another Slack app than this Taskboard chooses. This Taskboard chooses {s.slackApp.name ? `the ${s.slackApp.name} app, ` : ''}client ID <code>{s.slackApp.clientId}</code>, team <code>{s.slackApp.teamId}</code>, from {source}. "Use this Slack app" writes it and restarts A2A Notes. Then disconnect Slack on the A2A Notes review page and connect Slack again.
      <div><button className="btn" disabled={busy} onClick={apply}>{busy ? 'Changing…' : 'Use this Slack app'}</button></div></div>}
    <details>
      <summary>Choose the Slack app</summary>
      <label className="opt" htmlFor="a2a-client-id">Slack client ID</label>
      <input id="a2a-client-id" value={clientId} onChange={e => setClientId(e.target.value)} placeholder={s.slackApp.source === 'settings' ? '' : s.slackApp.clientId} spellCheck={false} />
      <label className="opt" htmlFor="a2a-team-id">Slack team ID</label>
      <input id="a2a-team-id" value={teamId} onChange={e => setTeamId(e.target.value)} placeholder={s.slackApp.source === 'settings' ? '' : s.slackApp.teamId} spellCheck={false} />
      <div className="sub">Empty: the environment variables TASKBOARD_A2A_SLACK_CLIENT_ID and TASKBOARD_A2A_SLACK_TEAM_ID, else the A2A Notes app (8696283833057.12198817279122) in team T08LG8BQH1P. Setup uses this app for new A2A Notes settings. For settings that exist, click "Use this Slack app" after you save.</div>
      {error && <div role="alert">{error}</div>}
      <div><button className="btn" disabled={busy || (clientId.trim() === saved.clientId && teamId.trim() === saved.teamId)} onClick={() => void save()}>Save</button></div>
    </details>
  </>;
}

// A2A Notes (server/a2anotes): setup of the separate service, and its own Slack sign-in.
function A2ANotesCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const load = async () => setStatus(await a2aRequest('/status'));
  const { busy, error, act } = useAction(load);
  useEffect(() => { void load().catch(() => {}); const timer = setInterval(() => { void load().catch(() => {}); }, 15_000); return () => clearInterval(timer); }, []);
  const s = status?.setup, c = status?.connection;
  const setup = () => act(() => a2aRequest('/setup', {}));
  const [startedAt, setStartedAt] = useState(signInStarted);
  useEffect(() => { if (c?.signed_in && startedAt) { setSignInStarted(0); setStartedAt(0); } }, [c?.signed_in, startedAt]);
  const connect = () => act(async () => { const url = (await a2aRequest('/slack-sign-in', {})).url; const now = Date.now(); setSignInStarted(now); setStartedAt(now); location.assign(url); });
  const signInFailed = !!(startedAt && status?.enabled && !status.error && c && !c.signed_in && !busy);
  return <div className="ctl-box">
    <b>A2A Notes (Slack)</b>
    <div className="sub">Sends messages between people and their agents over Slack, also to people who do not use Taskboard. It runs as its own service on this computer and has its own Slack sign-in. The messages are on the Inbox page, in Messages and Sent.</div>
    {!status ? <div>Loading…</div> : <>
      <div>{!status.enabled ? 'Not set up.'
        : status.error ? `Not reachable: ${status.error}`
        : c?.signed_in ? `Connected as ${status.identity?.name}. Last scan: ${c.last_scan_at ? new Date(c.last_scan_at).toLocaleString() : 'never'}.`
        : 'Running. Connect Slack to send and receive messages.'}</div>
      {s && !s.installed && <div role="alert">A2A Notes is not installed with this Taskboard. Run pnpm install in the Taskboard folder.</div>}
      {c?.last_error && <div role="alert">Last scan error: {c.last_error}</div>}
      {!!c?.missing_scopes.length && <div role="alert">Missing Slack scopes: {c.missing_scopes.join(', ')}</div>}
      <ServiceVersion setup={s} />
      {status.enabled && s && <div className="sub">Message checks: {s.checks === 'model' ? 'Claude with the controller account, and the fixed rules.' : 'the fixed rules only. Claude checks need the claude program and a Claude controller account.'}</div>}
      {status.enabled && s?.checksOutdated && <div>The message check settings changed (for example the controller account). Update A2A Notes to use them.</div>}
      {!status.enabled && s?.installed && <div className="sub">Setup writes the A2A Notes settings in {s.folder}, starts the service{s.running ? ' (it is already running)' : ''}, keeps it running after you sign in to this computer, and connects Taskboard to it.</div>}
      {s && <SlackAppSettings status={status} busy={busy} apply={() => act(() => a2aRequest('/setup', { applySlackApp: true }))} />}
      {signInFailed && s && <div role="alert">
        <div>Slack sign-in did not finish.</div>
        {s.signInHelp.map(line => <div key={line}>{line}</div>)}
        <div><button className="btn" onClick={() => { setSignInStarted(0); setStartedAt(0); }}>Hide</button></div>
      </div>}
      {error && <div role="alert">{error}</div>}
      <div className="mail-tabs">
        {!status.enabled && <button className="btn" disabled={busy || !s?.installed} onClick={setup}>{busy ? 'Setting up…' : 'Set up A2A Notes'}</button>}
        {status.enabled && status.error && s && !s.running && <button className="btn" disabled={busy} onClick={setup}>{busy ? 'Starting…' : 'Start A2A Notes'}</button>}
        {(s?.updateAvailable || (status.enabled && s?.checksOutdated)) && <button className="btn" disabled={busy} onClick={setup}>{busy ? 'Restarting…' : s?.updateAvailable ? 'Restart A2A Notes' : 'Update A2A Notes'}</button>}
        {status.enabled && !status.error && !c?.signed_in && <button className="btn" disabled={busy} onClick={connect}>Connect Slack</button>}
      </div>
    </>}
  </div>;
}

export function Integrations() {
  return <SettingGroup section="messages" id="integrations" title="Integrations" help="The sign-ins that Taskboard uses. Each integration has its own card." bare>
    <SettingItem id="a2aNotes"><A2ANotesCard /></SettingItem>
  </SettingGroup>;
}
