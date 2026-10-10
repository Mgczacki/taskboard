// Accounts: each account is a settings folder, so several run side by side. Sign in through a terminal here;
// limit resets are used only by you, from this page.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Agent, MachineInfo, Task } from '../api';
import { AGENTS, AGENT_NAME, fmtWait } from '../api';
import { usageText } from '../accountUsageText';
export { usageText } from '../accountUsageText';
import { Terminal } from './Terminal';
import { SettingItem } from './SettingsLayout';

export interface Account {
  id: string; agent: Agent; name: string; dir: string; isDefault?: boolean; maxParallel: number;
  routingRules?: string;
  limited?: { at: string; note: string }; health?: string;
  probe?: { at: string; result: 'accepted' | 'rejected' | 'failed'; note: string; manual?: boolean }; nextProbeAt?: number; probing?: boolean; // server/account-probe.ts
  status: { signedIn: boolean; who?: string }; running: number;
  usage?: { windows: { label: string; usedPct: number; resetsAt?: number }[]; at: string; source: string; plan?: string };
  usageStale?: boolean; usageStaleHours?: number; // data older than usageStaleHours counts as unknown (server/accounts.ts)
}
const resetText = (ms?: number) => {
  if (!ms) return '';
  const d = new Date(ms), mins = Math.round((ms - Date.now()) / 60000);
  return mins < 0 ? 'reset' : mins < 60 * 20 ? `resets in ${fmtWait(mins)} (${d.toTimeString().slice(0, 5)})` : `resets ${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.toTimeString().slice(0, 5)}`;
};
// The last check of a limit mark and the time of the next one (server/account-probe.ts).
const PROBE_TEXT = { accepted: 'a model answered, so the mark was cleared', rejected: 'the provider refused the request, so the mark stays', failed: 'no answer, so the mark stays' };
const hhmm = (ms: number) => new Date(ms).toDateString() === new Date().toDateString() ? new Date(ms).toTimeString().slice(0, 5) : `${new Date(ms).toLocaleDateString(undefined, { weekday: 'short' })} ${new Date(ms).toTimeString().slice(0, 5)}`;
function ProbeNote({ a }: { a: Account }) {
  const p = a.probe, ago = p ? Math.round((Date.now() - Date.parse(p.at)) / 60000) : 0;
  if (!p && !a.limited) return null;
  return <div className="sub probe-note">
    {p ? <>Last check {ago < 1 ? 'just now' : fmtWait(ago) + ' ago'}{p.manual ? ' (started by you)' : ''}: {PROBE_TEXT[p.result]}.{p.result !== 'accepted' && p.note ? ` ${p.note}` : ''}</> : a.limited ? 'Not checked yet.' : ''}
    {a.limited && (a.probing ? ' A check runs now.' : a.nextProbeAt ? ` Next check ${a.nextProbeAt <= Date.now() ? 'in the next 5 minutes' : 'at about ' + hhmm(a.nextProbeAt)}.` : ' Automatic checks are off.')}
  </div>;
}
function UsageBars({ a }: { a: Account }) {
  if (!a.usage) return <span className="sub">{a.agent === 'claude' ? 'Shows up once a Taskboard Claude Code session on this account runs (read from its status line).' : a.agent === 'codex' ? 'Shows up once this account has a Codex session (read from its session files).' : 'Shows up once a Taskboard Antigravity session runs (read from its status line).'}</span>;
  const ago = Math.round((Date.now() - Date.parse(a.usage.at)) / 60000);
  return <div className="usage">
    {a.usage.windows.map(w => { const done = !!w.resetsAt && w.resetsAt < Date.now(); const pct = done ? 0 : w.usedPct; return (
      <div key={w.label} className="uw" title={`${w.label} window: ${w.usedPct}% used${w.resetsAt ? ' · ' + resetText(w.resetsAt) : ''}`}>
        <span className="ul">{w.label}</span>
        <span className="ubar"><span className={pct >= 90 ? 'hi' : pct >= 70 ? 'mid' : ''} style={{ width: `${Math.min(100, pct)}%` }} /></span>
        <span className="up">{done ? 'reset' : `${w.usedPct}%`}</span><span className="sub">{done ? '' : resetText(w.resetsAt)}</span>
      </div>); })}
    <div className="sub">{a.usage.plan ? `${a.usage.plan} plan · ` : ''}as of {ago < 1 ? 'just now' : fmtWait(ago) + ' ago'} · {a.usage.source}</div>
    {a.usageStale && <div className="sub warn">These numbers are older than {a.usageStaleHours} h, so Taskboard counts this account's usage as unknown. Codex writes new numbers only after a turn that works.</div>}
  </div>;
}
const post = (path: string, body: unknown = {}) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j; });
export const loadAccounts = (fresh = false) => fetch('/api/accounts' + (fresh ? '?fresh=1' : '')).then(r => r.json()) as Promise<Account[]>;
// A maximum number of tasks (1 to 100). Saves when the field loses focus or on Enter; shows the error under it.
export function MaxTasksInput({ value, onSave, disabled, label }: { value: number; onSave: (n: number) => Promise<void>; disabled?: boolean; label: string }) {
  const [text, setText] = useState(String(value));
  const [err, setErr] = useState('');
  useEffect(() => { setText(String(value)); setErr(''); }, [value]);
  const commit = async () => {
    if (text.trim() === String(value)) { setErr(''); return; }
    const n = Number(text);
    if (!/^\d+$/.test(text.trim()) || n < 1 || n > 100) { setErr('Enter a whole number from 1 to 100.'); return; }
    try { await onSave(n); setErr(''); } catch (e) { setErr(String((e as Error).message || e)); }
  };
  return <>
    <input className={`max-tasks${err ? ' bad' : ''}`} type="number" min={1} max={100} step={1} aria-label={label} title={label} value={text} disabled={disabled}
      onChange={e => setText(e.target.value)} onBlur={() => void commit()} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setText(String(value)); setErr(''); } }} />
    {err && <div className="field-err" role="alert">{err}</div>}
  </>;
}
type Load = { agents: number; medianMb: number; totalMb: number; memMb: number; noteAbove: number };
const gb = (mb: number) => mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;

const short = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');

// This machine's controller: its name (shown in the Claude app as "Taskboard controller · <name>"), whether it starts
// with Taskboard, its model, and Remote Control (Claude Code only).
// What Settings > Controller: skip permission prompts does for each agent: the flag (server/agents.ts
// CONTROLLER_SKIP_FLAGS) and its effect, in plain words
const SKIP_TEXT: Record<Agent, { flag: string; what: string }> = {
  claude: { flag: '--dangerously-skip-permissions', what: 'Claude Code runs every tool and command without a permission prompt, and auto mode does not review them.' },
  codex: { flag: '--dangerously-bypass-approvals-and-sandbox', what: 'Codex runs commands without approval prompts and without its sandbox. Commands can write to any folder and use the network.' },
  antigravity: { flag: '--dangerously-skip-permissions', what: 'Antigravity approves each tool call without a prompt, and Taskboard does not review its tool calls.' },
};

export function ControllerBox({ ctl, setErr }: { ctl?: Task; setErr: (s: string) => void }) {
  const [info, setInfo] = useState<MachineInfo | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [switchTo, setSwitchTo] = useState<Agent | null>(null);
  const [switching, setSwitching] = useState(false);
  useEffect(() => { api.info().then(i => { setInfo(i); setName(i.machine); }); }, [ctl?.remoteUrl, ctl?.agent]);
  if (!info) return null;
  const save = async (p: { name?: string; autostart?: boolean; remoteControl?: boolean; controllerComputerUse?: boolean; controllerSkipPermissions?: Partial<Record<Agent, boolean>>; controllerModels?: Partial<Record<Agent, string>> }) => {
    setBusy(true); try { const i = await api.updateInfo(p); setInfo(i); setName(i.machine); } catch (e) { setErr(String((e as Error).message || e)); } setBusy(false);
  };
  const s = info.settings.controller, agent = (ctl?.agent || s.agent || 'claude') as Agent, isClaude = agent === 'claude';
  const skip = s.skipPermissions ? !!s.skipPermissions[agent] : isClaude && s.dangerouslySkipPermissions;
  const doSwitch = async (to: Agent) => {
    setSwitching(true);
    try { await api.setControllerAgent(to); setInfo(await api.info()); } catch (e) { setErr(String((e as Error).message || e)); }
    setSwitching(false); setSwitchTo(null);
  };
  const setSkip = (on: boolean) => {
    if (on && !window.confirm(`Skip the permission prompts of the ${AGENT_NAME[agent]} controller?\n\nThe controller can then run commands without asking you. The Taskboard guard hook, the approval cards and the server checks of tb approve stay on.`)) return;
    void save({ controllerSkipPermissions: { [agent]: on } });
  };
  return (
    <div className="ctl-box">
      <SettingItem id="machineName"><div className="ctl-row"><b>This machine</b>
        <input type="text" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} onBlur={() => { if (name.trim() && name.trim() !== info.machine) save({ name }); }} title="The name the controller uses for itself, and its session name in the Claude app" />
        <span className="sub">host {info.host} · one Taskboard server per machine</span></div></SettingItem>
      <SettingItem id="controllerAgent"><div className="ctl-row"><label htmlFor="controller-agent"><b>Controller agent</b></label>
        <select id="controller-agent" value={switchTo || agent} disabled={busy || switching} onChange={e => { const to = e.target.value as Agent; setSwitchTo(to === agent ? null : to); }}>
          {AGENTS.map(a => <option key={a} value={a}>{AGENT_NAME[a]}{a === 'claude' ? ' (default)' : ''}</option>)}
        </select>
        <span className="sub">{switching ? `Starting the controller on ${AGENT_NAME[switchTo || agent]}…` : `Runs ${AGENT_NAME[agent]} on the account ${info.controller?.account || ctl?.account || 'default'}. The account for each agent is on the Accounts page.`}</span></div>
        {switchTo && !switching && <div className="ctl-confirm" role="alertdialog" aria-label="Switch the controller agent">
          <b>Switch the controller from {AGENT_NAME[agent]} to {AGENT_NAME[switchTo]}?</b>
          <ul>
            <li>The {AGENT_NAME[agent]} session ends now. A turn that runs now is cut off.</li>
            <li>The old conversation is not lost. It stays in the history of {AGENT_NAME[agent]}, and the controller log names its session id.</li>
            <li>{AGENT_NAME[switchTo]} starts a new conversation on the account that the controller used last for it, or on the least busy signed-in account that is not at its limit.</li>
            <li>It first reads a handoff note with the open tasks and the rules, and its rules file ({switchTo === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'} in the controller folder).</li>
          </ul>
          <div className="ctl-row"><button className="btn primary" onClick={() => void doSwitch(switchTo)}>Switch to {AGENT_NAME[switchTo]}</button><button className="btn ghost" onClick={() => setSwitchTo(null)}>Cancel</button></div>
        </div>}</SettingItem>
      <SettingItem id="controllerComputerUse"><label className="opt"><input type="checkbox" checked={agent !== 'antigravity' && s.computerUse} disabled={busy || agent === 'antigravity'} onChange={e => save({ controllerComputerUse: e.target.checked })} /> Allow the controller to control Mac apps</label><div className="sub">On by default for Claude Code and Codex. Antigravity has no per-session computer-use control. A change restarts the controller between turns. Task browser tools are separate.</div></SettingItem>
      <SettingItem id="controllerAutostart"><label className="opt" title="When the Taskboard server starts, it starts the controller; if the controller exits, Taskboard starts it again within a minute"><input type="checkbox" checked={s.autostart} disabled={busy} onChange={e => save({ autostart: e.target.checked })} /> Start the controller with Taskboard and keep it running</label></SettingItem>
      <SettingItem id="controllerSkipPermissions"><label className="opt"><input type="checkbox" checked={skip} disabled={busy || switching} onChange={e => setSkip(e.target.checked)} /> Controller: skip permission prompts ({AGENT_NAME[agent]}: <code>{SKIP_TEXT[agent].flag}</code>)</label>
        <div className="sub">Off by default. Each agent keeps its own value. {SKIP_TEXT[agent].what} A change restarts the controller between turns.</div>
        {skip && <div className="sub ctl-warn">Warning: the controller can now run commands without asking you.</div>}
        <div className="sub">These stay on when the prompts are skipped:
          <ul>
            <li>The Taskboard guard hook runs before each shell command. It blocks commands that stop the real Taskboard server, its agents or its login service. It was tested with this flag for each agent.</li>
            <li>Only you release, roll back and restart Taskboard, and approve merges and pushes, unless you ask the controller in its chat.</li>
            <li>The server checks <code>tb approve</code>, <code>tb pending answer</code>, <code>tb scope approve</code> and <code>tb permit approve</code>: each needs your exact words in the controller chat.</li>
          </ul></div></SettingItem>
      <SettingItem id="controllerModel"><div className="ctl-row"><label htmlFor="controller-model">Controller model for {AGENT_NAME[agent]}</label>
        <input id="controller-model" type="text" maxLength={80} key={`${agent}:${s.models[agent]}`} defaultValue={s.models[agent]} disabled={busy} placeholder="Use the agent default" onBlur={e => { const model = e.target.value.trim(); if (model !== s.models[agent]) save({ controllerModels: { [agent]: model } }); }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
        <span className="sub">A change restarts the controller between turns.</span></div></SettingItem>
      <SettingItem id="remoteControl"><label className="opt" title={isClaude ? 'Lets you continue the controller from claude.ai/code or the Claude mobile app' : `Remote Control is a Claude Code feature; it is off while the controller runs ${AGENT_NAME[agent]}`}><input type="checkbox" checked={s.remoteControl} disabled={busy || !isClaude} onChange={e => save({ remoteControl: e.target.checked })} /> Remote Control: reach the controller from the Claude app as “{info.controller?.label || 'Taskboard controller · ' + info.machine}”{!isClaude && ' (Claude Code only)'}</label>
      {isClaude && s.remoteControl && <div className="sub">{ctl?.remoteUrl ? <>Open it on any device: <a href={ctl.remoteUrl} target="_blank" rel="noreferrer">{ctl.remoteUrl}</a> — in the Claude mobile app it is listed under Code.</> : 'The link appears here once the controller runs with Remote Control. After a change, the controller restarts by itself as soon as it is between turns (its conversation continues).'}</div>}</SettingItem>
    </div>
  );
}

export function AccountsPage({ tasks }: { tasks: Task[] }) {
  const [list, setList] = useState<Account[]>([]);
  const [term, setTerm] = useState<null | { title: string; session: string; note: string }>(null);
  const [confirm, setConfirm] = useState<Account | null>(null);
  const [adding, setAdding] = useState<{ agent: Agent; name: string } | null>(null);
  const [err, setErr] = useState('');
  const [movingCtl, setMovingCtl] = useState(false);
  const [agentLoad, setAgentLoad] = useState<Load | null>(null);
  const accountRequest = useRef(0);
  const ctl = tasks.find(t => t.role === 'controller');
  const load = (fresh = false) => { const request = ++accountRequest.current; api.agentLoad().then(setAgentLoad).catch(() => setAgentLoad(null)); return loadAccounts(fresh).then(list => { if (request === accountRequest.current) setList(list); }).catch(e => { if (request === accountRequest.current) setErr(String(e.message || e)); }); };
  useEffect(() => { load(); const i = setInterval(() => load(), 15000); return () => clearInterval(i); }, []);
  useEffect(() => { load(); }, [tasks.length]);

  const signIn = async (a: Account) => { try { const r = await post(`/api/accounts/${a.id}/login`); setTerm({ title: `Sign in: ${a.name}`, session: r.session, note: a.agent === 'claude' ? 'Follow the steps in the terminal; the browser opens on this Mac. Close this window when it says you are signed in.' : a.agent === 'antigravity' ? 'Choose this account in Google. If Google shows a code, paste it into the prompt below the link and press Enter. When agy shows its prompt, type /exit.' : 'Follow the steps in the terminal (it prints a link or a device code). Close this window when it says you are logged in.' }); } catch (e) { setErr(String((e as Error).message)); } };
  const reset = async (a: Account) => {
    setConfirm(null);
    try {
      const r = await post(`/api/accounts/${a.id}/reset`);
      if (r.open) { window.open(r.open, '_blank'); setErr(r.note); return; }
      setTerm({ title: `Limit reset: ${a.name}`, session: r.session, note: 'Claude Code runs /limit-reset here. It clears the 5-hour limit once a week; the weekly limit still applies. Close this window when it is done.' });
    } catch (e) { setErr(String((e as Error).message)); }
  };
  const [checking, setChecking] = useState('');
  const check = async (a: Account) => {
    setChecking(a.id);
    try { await post(`/api/accounts/${a.id}/probe`); } catch (e) { setErr(String((e as Error).message)); }
    setChecking(''); void load();
  };
  const tasksOn = (a: Account) => tasks.filter(t => (t.account || `${t.agent}-default`) === a.id && t.status !== 'archived');
  const saveMax = async (a: Account, maxParallel: number) => {
    const r = await fetch(`/api/accounts/${a.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxParallel }) });
    const data = await r.json(); if (!r.ok) throw new Error(data.error || r.statusText);
    setList(current => current.map(x => x.id === a.id ? { ...x, maxParallel: data.maxParallel } : x));
  };
  const saveRule = async (a: Account, value: string) => {
    try {
      const r = await fetch(`/api/accounts/${a.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ routingRules: value }) });
      const data = await r.json(); if (!r.ok) throw new Error(data.error || r.statusText);
      setList(current => current.map(x => x.id === a.id ? { ...x, routingRules: data.routingRules } : x));
    } catch (e) { setErr(String((e as Error).message || e)); }
  };

  return (
    <div className="acc-page">
      <div className="acc-head">
        <div><h2>Accounts</h2><p>Each account keeps its own sign-in. Claude Code uses <code>CLAUDE_CONFIG_DIR</code>, Codex uses <code>CODEX_HOME</code>, and Antigravity uses a separate home and Keychain. New tasks pick the least busy signed-in account that is not at its limit, unless you choose one.</p></div>
        <div style={{ display: 'flex', gap: 8 }}><button className="btn" title="Checks the sign-in of each account and reads the Codex session files again for new usage numbers. Claude Code and Antigravity numbers come from their status lines while a task runs." onClick={() => load(true)}>Check sign-ins and usage</button><button className="btn primary" onClick={() => setAdding({ agent: 'claude', name: '' })}>＋ Add account</button></div>
      </div>
      {err && <div className="banner">{err} <button className="btn ghost" onClick={() => setErr('')}>OK</button></div>}
      {agentLoad && agentLoad.agents > agentLoad.noteAbove && <div className="banner">
        <b>{agentLoad.agents} agents run on this machine{agentLoad.medianMb > 0 ? `; each uses about ${agentLoad.medianMb} MB` : ''}.</b>
        <span className="sub">Together they use {gb(agentLoad.totalMb)} of {gb(agentLoad.memMb)} memory. This note shows above {agentLoad.noteAbove} agents: at about 500 MB each, that is a quarter of the memory. The rest is for the builds and tests that agents start. Nothing is blocked.</span>
      </div>}
      <ControllerBox ctl={ctl} setErr={setErr} />
      <div className="ctl-acct">
        <b>Controller runs on</b>
        <select className="acct-sel" value={ctl?.account || 'claude-default'} disabled={movingCtl} onChange={async e => { setMovingCtl(true); try { await api.setControllerAccount(e.target.value); } catch (x) { setErr(String((x as Error).message || x)); } setMovingCtl(false); load(); }}>
          {AGENTS.map(ag => <optgroup key={ag} label={AGENT_NAME[ag]}>
            {list.filter(a => a.agent === ag).map(a => <option key={a.id} value={a.id} disabled={!a.status.signedIn}>{a.name}{a.status.signedIn ? '' : ' (not signed in)'}{a.limited ? ' · at its limit' : ''}{usageText(a) ? ' · ' + usageText(a) : ''}</option>)}
          </optgroup>)}
        </select>
        <span className="sub">{movingCtl ? 'Restarting the controller on that account…' : 'Changing it restarts the controller on that account. Between two Claude Code accounts the conversation continues. An account of another agent switches the controller agent, as in Settings > Controller agent: a new conversation that starts with a handoff note. Between Codex accounts a new conversation starts with the same instructions. Tasks the controller starts pick their own account.'}</span>
      </div>
      <div className="tb"><table><colgroup><col style={{ width: '20%' }} /><col style={{ width: '16%' }} /><col style={{ width: '30%' }} /><col style={{ width: 190 }} /><col /></colgroup><tbody>
        {list.map(a => (
          <tr key={a.id} className="r">
            <td><span className={`chip agent-${a.agent}`}>{AGENT_NAME[a.agent]}</span> <b>{a.name}</b><div className="mono" style={{ marginTop: 4 }}>{short(a.dir)}</div><label className="sub">Routing rule<input className="routing-rule" type="text" maxLength={500} defaultValue={a.routingRules || ''} key={`${a.id}:${a.routingRules || ''}`} placeholder="When should the controller use this account?" onBlur={e => { if (e.target.value !== (a.routingRules || '')) void saveRule(a, e.target.value); }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} /></label></td>
            <td>{a.status.signedIn ? <span className="st-label unread">✓ signed in</span> : <span className="st-label needs-you">not signed in</span>}<div className="sub">{a.status.who || ''}</div></td>
            <td>{a.health && <div className="sub ae-health" title="Several tasks of this account stopped on an overloaded model in the last 15 minutes. It usually passes. Taskboard does not switch accounts or models because of it.">Health note, not a limit: {a.health}</div>}{a.limited && <><span className="st-label stopped">stopped by a limit</span><div className="sub">since {fmtWait(Math.round((Date.now() - Date.parse(a.limited.at)) / 60000))} ago · {a.limited.note}</div></>}<ProbeNote a={a} /><UsageBars a={a} /></td>
            <td className="max-cell"><span className="mono">{a.running} / </span><MaxTasksInput value={a.maxParallel} label={`Maximum number of tasks for ${a.name}`} onSave={n => saveMax(a, n)} /> <span className="sub">tasks</span>
              <div className="sub mono">{tasksOn(a).map(t => '#' + t.num).slice(0, 6).join(' ')}</div>
              {a.running >= a.maxParallel && <div className="sub">{a.running > a.maxParallel ? `${a.running} run, which is more than the maximum. They keep running.` : 'At the maximum.'} New tasks on this account are refused until fewer than {a.maxParallel} run.</div>}</td>
            <td className="acts">
              {!a.status.signedIn && <button className="btn primary" onClick={() => signIn(a)}>Sign in</button>}
              {a.status.signedIn && <button className="btn" onClick={() => signIn(a)} title="Sign in again or switch the login in this folder">Sign in again</button>}
              <button className="btn" onClick={() => setConfirm(a)} title="Only you can use resets; the controller cannot">↺ Limit reset…</button>
              {a.limited && <button className="btn ghost" disabled={checking === a.id || a.probing} title="Sends one small request on this account. A reply from a model clears the limit mark. A limit or credit error keeps it." onClick={() => check(a)}>{checking === a.id || a.probing ? 'Checking…' : 'Check now'}</button>}
              {a.limited && <button className="btn ghost" onClick={() => post(`/api/accounts/${a.id}/clear-limit`).then(() => load())}>Clear limit mark</button>}
              {!a.isDefault && <button className="btn ghost" onClick={() => { if (confirmRemove(a)) fetch(`/api/accounts/${a.id}`, { method: 'DELETE' }).then(() => load()); }}>Remove</button>}
            </td>
          </tr>
        ))}
      </tbody></table></div>
      <p className="sub" style={{ marginTop: 14 }}>The number after “/” is the maximum number of running tasks for the account (1 to 100). Taskboard refuses a new task, a resume or a move onto an account at its maximum. When you lower it below the number that runs now, the running tasks keep running. Only new starts are refused. Only you can change it here; <code>tb</code>, agents and the controller cannot. Accounts that you add start with the default maximum on the Settings page.</p>
      <p className="sub">Limits are detected when a task stops with a limit or credit error. New tasks do not go to an account with a limit mark. The mark clears when a turn on that account succeeds, or when a check gets a reply from a model. A check is one small request that Taskboard sends outside every task: after the reset time of a full window, then at most once an hour for a usage limit and once in 6 hours for no credit, with a longer wait after each check that fails. A sign-in or an empty usage bar does not clear a mark. Removing an account only removes it from Taskboard; its folder and login stay on disk.</p>

      {adding && <div className="scrim open" onMouseDown={e => { if (e.target === e.currentTarget) setAdding(null); }}>
        <div className="modal" style={{ width: 460 }}>
          <header><h2>Add account</h2><button className="btn ghost icon" onClick={() => setAdding(null)}>✕</button></header>
          <div className="body">
            <div className="field"><label>Agent</label><div className="seg"><button className={adding.agent === 'claude' ? 'on' : ''} onClick={() => setAdding({ ...adding, agent: 'claude' })}>Claude Code</button><button className={adding.agent === 'codex' ? 'on' : ''} onClick={() => setAdding({ ...adding, agent: 'codex' })}>Codex</button><button className={adding.agent === 'antigravity' ? 'on' : ''} onClick={() => setAdding({ ...adding, agent: 'antigravity' })}>Antigravity</button></div></div>
            <div className="field"><label>Name</label><input type="text" autoFocus value={adding.name} onChange={e => setAdding({ ...adding, name: e.target.value })} placeholder="e.g. Work, Personal Max, Client X" /></div>
            <div className="help" style={{ fontSize: 12, color: 'var(--dim)' }}>Creates a new {adding.agent === 'antigravity' ? 'home and Keychain' : 'settings folder'} like <code>~/.{adding.agent === 'antigravity' ? 'agy' : adding.agent}-{(adding.name || 'name').toLowerCase().replace(/[^a-z0-9]+/g, '-')}</code>. Sign in to it next.</div>
          </div>
          <footer><span style={{ flex: 1 }} /><button className="btn" onClick={() => setAdding(null)}>Cancel</button><button className="btn primary" onClick={async () => { if (!adding.name.trim()) return; try { const a = await post('/api/accounts', adding); setAdding(null); await load(); signIn(a); } catch (e) { setErr(String((e as Error).message)); } }}>Add and sign in</button></footer>
        </div>
      </div>}

      {confirm && <div className="scrim open" onMouseDown={e => { if (e.target === e.currentTarget) setConfirm(null); }}>
        <div className="modal" style={{ width: 520 }}>
          <header><h2>Use a limit reset on {confirm.name}?</h2><button className="btn ghost icon" onClick={() => setConfirm(null)}>✕</button></header>
          <div className="body" style={{ fontSize: 13, color: 'var(--muted)' }}>
            {confirm.agent === 'claude'
              ? <><div><b style={{ color: 'var(--text)' }}>What it does:</b> runs <code>/limit-reset</code> in a Claude Code session using <code>{short(confirm.dir)}</code>. It clears the 5-hour limit; the weekly limit still applies. Each account can do this about once a week, and some accounts do not have it yet.</div>
                <div><b style={{ color: 'var(--text)' }}>Waiting on this account:</b> {tasksOn(confirm).filter(t => ['stopped', 'needs-you'].includes(t.status)).map(t => `#${t.num}`).join(', ') || 'nothing'}</div></>
              : confirm.agent === 'codex' ? <div>Codex has no command-line reset. This opens the Codex usage page, where you can spend a banked reset.</div>
              : <div>Antigravity has no limit reset. Its quota resets on its own. This opens the page about AI credits, which <code>/credits</code> in <code>agy</code> shows and sells.</div>}
            <div>Only you can do this; the controller agent cannot.</div>
          </div>
          <footer><span style={{ flex: 1 }} /><button className="btn" onClick={() => setConfirm(null)}>Cancel</button><button className="btn primary" onClick={() => reset(confirm)}>{confirm.agent === 'claude' ? 'Run /limit-reset' : confirm.agent === 'codex' ? 'Open the usage page' : 'Open the credits page'}</button></footer>
        </div>
      </div>}

      {term && <div className="scrim open">
        <div className="modal" style={{ width: 900 }}>
          <header><h2>{term.title}</h2><button className="btn ghost icon" onClick={() => { setTerm(null); load(true); }}>✕</button></header>
          <div className="body"><div className="sub">{term.note}</div><div style={{ height: 'min(70vh, 650px)', display: 'flex', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}><Terminal taskId="" session={term.session} autoFocus /></div></div>
          <footer><span style={{ flex: 1 }} /><button className="btn primary" onClick={() => { setTerm(null); load(true); }}>Done</button></footer>
        </div>
      </div>}
    </div>
  );
}
function confirmRemove(a: Account) { return window.confirm(`Remove ${a.name} from Taskboard? Its folder ${a.dir} and its login stay on disk.`); }
