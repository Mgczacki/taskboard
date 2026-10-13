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

function SlackDesktopSettings({status, busy, apply}: {status: Status; busy: boolean; apply: (url: string, team: string) => void}) {
  const settings = status.setup!.desktop;
  const [url, setUrl] = useState(settings.url), [team, setTeam] = useState(settings.teamId);
  return <details>
    <summary>Slack Desktop connection</summary>
    <p>A2A Notes uses the signed-in Slack app. It does not use OAuth or Slack Web API tokens.</p>
    <p>Slack must run with its debugging port restricted to this computer. The connector reads app messages and uses app controls.</p>
    <label htmlFor="a2a-desktop-url">Local app endpoint</label>
    <input id="a2a-desktop-url" value={url} onChange={e => setUrl(e.target.value)} spellCheck={false} />
    <label htmlFor="a2a-desktop-team">Slack workspace ID</label>
    <input id="a2a-desktop-team" value={team} onChange={e => setTeam(e.target.value)} spellCheck={false} />
    <p>Small attachments travel in the message data. The complete message must fit within 39,000 bytes. History recovery reads messages available in the app.</p>
    <p>Quit Slack normally. Start Slack with: <code>open -a /Applications/Slack.app --args --remote-debugging-address=127.0.0.1 --remote-debugging-port={new URL(settings.url).port}</code></p>
    <button className="btn" disabled={busy} onClick={() => apply(url, team)}>Save app connection</button>
  </details>;
}

function SlackTaskAliases() {
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [tasks, setTasks] = useState<{ id: string; num: number; title: string }[]>([]);
  const [name, setName] = useState(''), [task, setTask] = useState('');
  const load = async () => { const result = await a2aRequest('/aliases'); setAliases(result.aliases); setTasks(result.tasks); };
  const { busy, error, act } = useAction(load);
  useEffect(() => { void load().catch(() => {}); }, []);
  return <details className="a2a-task-aliases">
    <summary>Message your tasks from Slack</summary>
    <p>Write in your Slack self-conversation. Put the destination on the first line, then write your request.</p>
    <pre>{'A2A #430\nPlease check the current status.'}</pre>
    <p><code>A2A @controller</code> goes to Taskboard's controller. <code>A2A @name</code> uses an alias registered below.</p>
    <p>Your verified account needs no acceptance card. Message checks still apply. Separate action approvals still apply.</p>
    <p>Other accounts keep the existing acceptance rules. Ordinary Slack text and mentions stay outside this flow.</p>
    <form onSubmit={e => { e.preventDefault(); void act(async () => { await a2aRequest('/aliases', { name: name.trim(), task }); setName(''); }); }}>
      <label htmlFor="a2a-task-alias">Alias</label>
      <input id="a2a-task-alias" value={name} onChange={e => setName(e.target.value)} placeholder="research" pattern="[a-z](?:[a-z0-9_]|-){0,31}" maxLength={32} required />
      <label htmlFor="a2a-alias-task">Task</label>
      <select id="a2a-alias-task" value={task} onChange={e => setTask(e.target.value)} required>
        <option value="">Choose a task</option>
        {tasks.filter(t => t.id !== 'controller').map(t => <option key={t.id} value={t.id}>#{t.num} {t.title}</option>)}
      </select>
      <button className="btn" disabled={busy || !name.trim() || !task}>Save alias</button>
    </form>
    <ul>{Object.entries(aliases).map(([alias, id]) => <li key={alias}><code>@{alias}</code> → {tasks.find(t => t.id === id)?.title || 'Task unavailable'}{' '}
      <button type="button" className="btn" disabled={busy} onClick={() => void act(() => a2aRequest('/aliases', { name: alias, task: null }))}>Remove {alias}</button>
    </li>)}</ul>
    {error && <p role="alert">{error}</p>}
  </details>;
}

// A2A Notes (server/a2anotes): setup of the separate service, and its own Slack sign-in.
function A2ANotesCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const load = async () => setStatus(await a2aRequest('/status'));
  const { busy, error, act } = useAction(load);
  useEffect(() => { void load().catch(() => {}); const timer = setInterval(() => { void load().catch(() => {}); }, 15_000); return () => clearInterval(timer); }, []);
  const s = status?.setup, c = status?.connection;
  const setup = () => act(() => a2aRequest('/setup', {}));
  const connect = () => act(() => a2aRequest('/slack-connect', {}));
  return <div className="ctl-box">
    <b>A2A Notes (Slack)</b>
    <div className="sub">Sends messages between people and their agents over Slack, also to people who do not use Taskboard. It runs as its own service on this computer and uses the signed-in Slack Desktop account. The messages are on the Inbox page, in Messages and Sent.</div>
    {!status ? <div>Loading…</div> : <>
      <div>{!status.enabled ? 'Not set up.'
        : status.error ? `Not reachable: ${status.error}`
        : c?.available === false && c.signed_in ? 'The Slack app is not reachable. Open it to continue.'
        : c?.signed_in ? `Connected as ${status.identity?.name}. Last scan: ${c.last_scan_at ? new Date(c.last_scan_at).toLocaleString() : 'never'}.`
        : 'Running. Open Slack Desktop and connect its account to send and receive messages.'}</div>
      {s && !s.installed && <div role="alert">A2A Notes is not installed with this Taskboard. Run pnpm install in the Taskboard folder.</div>}
      {c?.last_error && <div role="alert">Last scan error: {c.last_error}</div>}
      {!!c?.missing_scopes.length && <div role="alert">Missing Slack scopes: {c.missing_scopes.join(', ')}</div>}
      <ServiceVersion setup={s} />
      {status.enabled && s && <div className="sub">Message checks: {s.checks === 'model' ? 'Claude with the controller account, and the fixed rules.' : 'the fixed rules only. Claude checks need the claude program and a Claude controller account.'}</div>}
      {status.enabled && s?.checksOutdated && <div>The message check settings changed (for example the controller account). Update A2A Notes to use them.</div>}
      {!status.enabled && s?.installed && <div className="sub">Setup writes the A2A Notes settings in {s.folder}, starts the service{s.running ? ' (it is already running)' : ''}, keeps it running after you sign in to this computer, and connects Taskboard to it.</div>}
      {c?.signed_in && <SlackTaskAliases />}
      {s && <SlackDesktopSettings status={status} busy={busy} apply={(desktopUrl, teamId) => act(() => a2aRequest('/setup', {desktopUrl, teamId}))} />}
      {error && <div role="alert">{error}</div>}
      <div className="mail-tabs">
        {!status.enabled && <button className="btn" disabled={busy || !s?.installed} onClick={setup}>{busy ? 'Setting up…' : 'Set up A2A Notes'}</button>}
        {status.enabled && status.error && s && !s.running && <button className="btn" disabled={busy} onClick={setup}>{busy ? 'Starting…' : 'Start A2A Notes'}</button>}
        {(s?.updateAvailable || (status.enabled && s?.checksOutdated)) && <button className="btn" disabled={busy} onClick={setup}>{busy ? 'Restarting…' : s?.updateAvailable ? 'Restart A2A Notes' : 'Update A2A Notes'}</button>}
        {status.enabled && !status.error && <button className="btn" disabled={busy} onClick={() => act(() => a2aRequest('/slack-disconnect', {}))}>Disconnect app connector</button>}
        {status.enabled && !status.error && !c?.signed_in && <button className="btn" disabled={busy} onClick={connect}>Connect Slack Desktop</button>}
      </div>
    </>}
  </div>;
}

export function Integrations() {
  return <SettingGroup section="messages" id="integrations" title="Integrations" help="The sign-ins that Taskboard uses. Each integration has its own card." bare>
    <SettingItem id="a2aNotes"><A2ANotesCard /></SettingItem>
  </SettingGroup>;
}
