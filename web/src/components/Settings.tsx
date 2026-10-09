// Settings: what the controller and other agents may do without asking, and this machine's controller. The page has
// one section for each entry of SECTIONS in settingsIndex.ts, a side list of those sections and a search box.
import { useEffect, useRef, useState } from 'react';
import type { AllowRule, BuiltInRule, BrowserMode, BrowserStatus, ConfirmRisk, ControllerApprovals, MachineInfo, MessageLevel, PushRecord, RestartImpact, RestartResult, Task } from '../api';
import { cardNotify, cardSound, setCardNotify, setCardSound } from '../cardAlert';
import { api, autoReload, confirmEnd, DEFAULT_CONFIRM_RISK, DEFAULT_CONTROLLER_APPROVALS, setAutoReload, setConfirmEnd, useStore } from '../api';
import { reasonText, type ServerHealth } from '../serverStatus';
import { setWindowSee, windowSee, windowSeeSupported } from '../controllerView';
import { infoDefault, setInfoDefault, type InfoDefault } from '../taskNotices';
import { GlassControls, useGlass, useReadable } from './GlassControls';
import { onPerfChange, perfOn, setPerfOn } from '../perfStats';
import { onRendererChange, setWebglOn, webglOn } from '../terminalRenderer';
import { ControllerBox, MaxTasksInput, loadAccounts } from './Accounts';
import { MessageLevels } from './MessageLevels';
import { Integrations } from './Integrations';
import { RulesFiles } from './RulesFiles';
import { BrowserView } from './TaskBrowser';
import { SigninSettings } from './BrowserSignins';
import type { Account } from './Accounts';
import type { KeyAction } from '../keys';
import { ACTIONS, CTX_NAME, comboOf, fmtCombo, isCustom, keysOf, resetKeys, setKeys, setRecording, useKeymap } from '../keys';
import { filterSettings, matcher, settingText } from '../settingsIndex';
import { SettingGroup, SettingItem, SettingSection, SettingsFilterProvider, SettingsNav, hashSection, sectionAnchor } from './SettingsLayout';
import { Processes } from './Processes';

type StandingRule = { id: string; action: 'push' | 'deploy-dev' | 'catalog-stage'; actor: string; target: string; limitPerDay: number };
function StandingRules({ tasks }: { tasks: Task[] }) {
  const [rules, setRules] = useState<StandingRule[]>([]);
  const [action, setAction] = useState<StandingRule['action']>('push');
  const [actor, setActor] = useState('');
  const [target, setTarget] = useState('');
  const [limitPerDay, setLimit] = useState(1);
  const [error, setError] = useState('');
  const load = () => void fetch('/api/standing-approvals').then(r => r.json()).then(setRules).catch(() => {});
  useEffect(load, []);
  const add = async () => {
    const r = await fetch('/api/standing-approvals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, actor, target, limitPerDay }) });
    const data = await r.json();
    if (!r.ok) return setError(data.error || 'Could not save the rule.');
    setError(''); setTarget(''); load();
  };
  const remove = async (id: string) => { await fetch(`/api/standing-approvals/${id}`, { method: 'DELETE' }); load(); };
  return <div>
    <div className="opt">Allow one action for one task and target, up to a daily limit.</div>
    <div className="row2">
      <label>Action <select value={action} onChange={e => setAction(e.target.value as StandingRule['action'])}><option value="push">Push to a branch</option><option value="deploy-dev">Deploy to Dev</option><option value="catalog-stage">Publish relay catalog draft to Stage</option></select></label>
      <label>Task <select value={actor} onChange={e => setActor(e.target.value)}><option value="">Choose a task</option>{tasks.filter(t => t.role !== 'controller').map(t => <option value={t.id} key={t.id}>#{t.num} {t.title}</option>)}</select></label>
      <label>Target <input value={target} onChange={e => setTarget(e.target.value)} placeholder={action === 'push' ? 'branch name' : action === 'deploy-dev' ? 'service@dev' : 'catalog@stage'} /></label>
      <label>Uses each day <input type="number" min="1" max="20" value={limitPerDay} onChange={e => setLimit(Number(e.target.value))} /></label>
    </div>
    <button className="btn" disabled={!actor || !target} onClick={() => void add()}>Add rule</button>
    {error && <div className="banner">{error}</div>}
    {rules.map(rule => <div className="sub" key={rule.id}>{rule.action} · #{tasks.find(t => t.id === rule.actor)?.num || rule.actor} · {rule.target} · {rule.limitPerDay} uses each day <button className="btn ghost" onClick={() => void remove(rule.id)}>Remove</button></div>)}
  </div>;
}

// One checkbox for each risk kind of a card option (server/machine.ts confirmRisk).
const CONFIRM_RISK_ROWS: [keyof ConfirmRisk, string][] = [
  ['wideAccess', 'Gives wide access: the answer adds a rule, for example "always allow access to <folder>"'],
  ['installs', 'Installs software: the answer downloads or installs a program'],
  ['spends', 'Asks for more credit: the answer asks for more credit or a higher limit'],
  ['exits', 'Ends the agent session: the answer stops the agent of the task'],
];

// One checkbox for each kind of approval card that the controller may approve on the user's request in its chat
// (server/machine.ts controllerApprovals). The note says the extra check of the high impact kinds.
const CONTROLLER_APPROVAL_ROWS: [keyof ControllerApprovals, string, string?][] = [
  ['merge', 'Merge into local master'],
  ['push', 'Push', 'A push to a protected branch needs the branch name in your message.'],
  ['forcePush', 'Force push', 'Your message must say force.'],
  ['release', 'Release Taskboard', 'Your message must say release. Only one release or restart at a time.'],
  ['restart', 'Restart Taskboard', 'Your message must say restart. Only one release or restart at a time.'],
  ['scope', 'Scope requests (worktree and read access)'],
  ['permit', 'Permits', 'Software installs and sign-ins stay with you.'],
  ['mail', 'Message drafts', 'Your message must name the draft by its card or message id.'],
];

// Search text for the keyboard shortcuts: the name of every action and of its place.
const KEY_SEARCH = { keyboardShortcuts: ACTIONS.map(a => `${CTX_NAME[a.ctx]} ${a.label}`).join('\n') };

export function SettingsPage({ tasks }: { tasks: Task[] }) {
  const [info, setInfo] = useState<MachineInfo | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [reloadOn, setReloadOn] = useState(autoReload());
  const [askEnd, setAskEnd] = useState(confirmEnd());
  const [notifyCards, setNotifyCards] = useState(cardNotify());
  const [soundCards, setSoundCards] = useState(cardSound());
  const glass = useGlass(), readable = useReadable(glass);
  const [winSee, setWinSeeState] = useState(windowSee);
  const [perfShown, setPerfShown] = useState(perfOn());
  useEffect(() => onPerfChange(() => setPerfShown(perfOn())), []);
  const [webgl, setWebgl] = useState(webglOn());
  useEffect(() => onRendererChange(() => setWebgl(webglOn())), []);
  const [infoDef, setInfoDef] = useState(infoDefault);
  const [accts, setAccts] = useState<Account[]>([]);
  const [routingRules, setRoutingRules] = useState('');
  const [applyAll, setApplyAll] = useState(false); // the confirmation for "Apply to all accounts" is open
  const [permitFolders, setPermitFolders] = useState('');
  const [tenMinuteLimit, setTenMinuteLimit] = useState('5');
  const [dayLimit, setDayLimit] = useState('20');
  const [confirmPermits, setConfirmPermits] = useState(false);
  const [pushes, setPushes] = useState<PushRecord[]>([]);
  const [ownRepositories, setOwnRepositories] = useState('');
  const [protectedBranches, setProtectedBranches] = useState('');
  const [query, setQuery] = useState('');
  const pageRef = useRef<HTMLDivElement>(null);
  const [scopeMax, setScopeMax] = useState('8');
  useEffect(() => { api.info().then(i => { setInfo(i); setRoutingRules(i.settings.routingRules || ''); setPermitFolders((i.settings.permitFolders || []).join('\n')); setScopeMax(String(i.settings.scopeLimit.max)); setTenMinuteLimit(String(i.settings.permitRequestLimits.tenMinutes)); setDayLimit(String(i.settings.permitRequestLimits.day)); setOwnRepositories((i.settings.pushes?.ownRepositories || []).join('\n')); setProtectedBranches((i.settings.pushes?.protectedBranches || []).join('\n')); }).catch(e => setErr(String(e.message || e))); loadAccounts().then(setAccts).catch(() => {}); api.pushes().then(setPushes).catch(() => {}); }, []);
  // #settings:<section> opens the page at that section
  useEffect(() => {
    const go = () => { const id = hashSection(); if (id) document.getElementById(sectionAnchor(id))?.scrollIntoView({ block: 'start' }); };
    const timer = setTimeout(go, 50);
    addEventListener('hashchange', go);
    return () => { clearTimeout(timer); removeEventListener('hashchange', go); };
  }, []);
  const save = async (p: { routingRules?: string; controllerNeedsApproval?: boolean; agentsNeedApproval?: boolean; allTaskCommunication?: boolean; trustWorkspaces?: boolean; autoReview?: boolean; controllerCanApprovePermits?: boolean; holdPermissionHook?: boolean; permitFolders?: string[]; permitRequestLimits?: Partial<MachineInfo['settings']['permitRequestLimits']>; scopeLimit?: Partial<MachineInfo['settings']['scopeLimit']>; pushTaskBranches?: 'run' | 'ask' | 'never'; ownRepositories?: string[]; protectedBranches?: string[]; askAgent?: 'claude' | 'codex'; askAccount?: string; askModel?: string; reviewAccount?: string; reviewModel?: string; messageIncoming?: MessageLevel; messageOutgoing?: MessageLevel; checkPrivateNotes?: boolean; confirmLowerControl?: boolean; defaultMaxParallel?: number; applyMaxParallelToAll?: boolean; browserClaude?: BrowserMode; browserCodex?: BrowserMode; chromePath?: string; confirmRisk?: Partial<ConfirmRisk>; controllerApprovals?: Partial<ControllerApprovals>; agentErrors?: Parameters<typeof api.updateInfo>[0]['agentErrors'] }) => {
    setBusy(true); try { setInfo(await api.updateInfo(p)); } catch (e) { setErr(String((e as Error).message || e)); } setBusy(false);
  };
  const ctl = tasks.find(t => t.role === 'controller');
  const p = info?.settings.permissions;
  const filter = filterSettings(query, KEY_SEARCH);
  return (
    <div className="acc-page set-page" ref={pageRef}>
      <div className="acc-head"><div><h2>Settings</h2><p>For this machine ({info?.machine || '…'}).</p></div></div>
      {err && <div className="banner">{err} <button className="btn ghost" onClick={() => setErr('')}>OK</button></div>}
      <SettingsFilterProvider value={filter}>
        <div className="set-layout">
          <SettingsNav query={query} setQuery={setQuery} filter={filter} pageRef={pageRef} />
          <div className="set-body">
            {filter.total === 0 && <div className="ctl-box"><div className="sub">No setting matches “{query.trim()}”.</div><div><button className="btn" onClick={() => setQuery('')}>Show all settings</button></div></div>}

            <SettingSection id="approvals">
              <SettingGroup section="approvals" id="tasks" title="Managing tasks" help={<>Starting tasks, typing into them, setting them aside and archiving them with <code>tb</code> can run at once or wait for your Approve / Deny card on the dashboard. Neither Claude Code, Codex nor Antigravity asks separately for <code>tb</code> commands of the controller; this is the one place that decides.</>}>
                {p && <>
                  <SettingItem id="controllerManagesTasks"><label className="opt" title="When on, the controller's tb new / send / park / archive / resume run immediately"><input type="checkbox" disabled={busy} checked={!p.controllerNeedsApproval} onChange={e => save({ controllerNeedsApproval: !e.target.checked })} /> The controller may create and manage tasks without asking</label></SettingItem>
                  <SettingItem id="agentsManageTasks"><label className="opt" title="Agents other than the controller that use tb to start or type into tasks"><input type="checkbox" disabled={busy} checked={!p.agentsNeedApproval} onChange={e => save({ agentsNeedApproval: !e.target.checked })} /> Other agents may start, type into, set aside and archive tasks without asking</label></SettingItem>
                  <SettingItem id="allTaskCommunication"><label className="opt"><input type="checkbox" disabled={busy} checked={p.allTaskCommunication} onChange={e => save({ allTaskCommunication: e.target.checked })} /> Tasks may send messages and outbox files to any other task without a card</label><div className="sub">This includes tasks in different groups and group managers. A task can use <code>tb doc read &lt;task&gt;:&lt;file&gt;</code> to read a named Markdown or text file from another task's outbox. Private task files, hidden files, and other paths are not available through this command. Each task pair has a limit of 30 messages, 30 documents, and 30 reads per hour. Taskboard records each use. Turn this off to restore the current approval rules for new sends and to stop these reads.</div></SettingItem>
                  <div className="sub">A change reaches the controller when it next restarts, which Taskboard does by itself as soon as the controller is between turns (its conversation continues). Releasing or rolling back Taskboard and stopping its server stay blocked for every agent.</div>
                </>}
              </SettingGroup>
              <SettingGroup section="approvals" id="controllerApprovals" title="Controller approvals" help={<>When you ask the controller in its chat to approve a card, it runs <code>tb approve</code> with your exact message. Taskboard checks that the message is yours, that it names the card and that the card did not change. A task, a mail or a log line can never approve a card.</>}>
                {info && <SettingItem id="controllerApprovalKinds">
                  <div className="opt">Let the controller approve this kind when I ask in the chat</div>
                  {CONTROLLER_APPROVAL_ROWS.map(([key, text, note]) => <label key={key} className="opt"><input type="checkbox" disabled={busy} checked={{ ...DEFAULT_CONTROLLER_APPROVALS, ...info.settings.controllerApprovals }[key]} onChange={e => void save({ controllerApprovals: { [key]: e.target.checked } })} /> {text}{note && <span className="sub"> {note}</span>}</label>)}
                  <div className="sub">Trust dialogs, sign-ins, wide access rules, refused tool calls and the controller's own actions stay with you.</div>
                </SettingItem>}
              </SettingGroup>
              <SettingGroup section="approvals" id="allowRules" title="Allow always rules" help={<>You add a rule with Allow always on a card where one task asks to type into another task or to send it a document. Only you add or revoke rules, on this dashboard. <code>tb allow list</code> shows them to tasks and the controller.</>}>
                <SettingItem id="allowRulesList"><AllowRules setErr={setErr} /></SettingItem>
              </SettingGroup>
              <SettingGroup section="approvals" id="standingRules" title="Standing approvals" help="Only you add these rules. Each use is saved with its rule and target.">
                <SettingItem id="standingRulesList"><StandingRules tasks={tasks} /></SettingItem>
              </SettingGroup>
              <SettingGroup section="approvals" id="scopes" title="Scope requests">
                {info && <SettingItem id="scopeLimit">
                  <label className="opt"><input type="checkbox" disabled={busy} checked={info.settings.scopeLimit.enabled} onChange={e => void save({ scopeLimit: { enabled: e.target.checked } })} /> Limit attached scopes per task</label>
                  <div className="sub">Current count maximum: {info.settings.scopeLimit.enabled ? info.settings.scopeLimit.max : 'off (no maximum)'}. Off by default. Read folders and attached worktrees count together. The initial task folder does not count. Every scope request still needs approval. Lowering the maximum keeps existing scopes and blocks new attachments at or above the maximum.</div>
                  <label className="opt" htmlFor="scope-limit-max">Maximum attached scopes <input id="scope-limit-max" type="number" min="1" step="1" disabled={busy} value={scopeMax} onChange={e => setScopeMax(e.target.value)} /></label>
                  <div><button className="btn" disabled={busy || !/^[1-9]\d*$/.test(scopeMax) || !Number.isSafeInteger(Number(scopeMax)) || Number(scopeMax) === info.settings.scopeLimit.max} onClick={() => void save({ scopeLimit: { max: Number(scopeMax) } })}>Save maximum</button></div>
                </SettingItem>}
              </SettingGroup>
              <SettingGroup section="approvals" id="permits" title="Permit requests">
                {info && <SettingItem id="permitRequestLimits">
                  <label className="opt"><input type="checkbox" disabled={busy} checked={info.settings.permitRequestLimits.enabled} onChange={e => void save({ permitRequestLimits: { enabled: e.target.checked } })} /> Limit permit requests per task</label>
                  <div className="sub">Current limits: {info.settings.permitRequestLimits.enabled ? `${info.settings.permitRequestLimits.tenMinutes} in 10 minutes and ${info.settings.permitRequestLimits.day} in 24 hours` : 'off'}. Failed and denied permits count. Every permit still needs risk review and approval.</div>
                  <label className="opt" htmlFor="permit-limit-ten">Requests in 10 minutes <input id="permit-limit-ten" type="number" min="1" max="1000" step="1" disabled={busy} value={tenMinuteLimit} onChange={e => setTenMinuteLimit(e.target.value)} /></label>
                  <label className="opt" htmlFor="permit-limit-day">Requests in 24 hours <input id="permit-limit-day" type="number" min="1" max="1000" step="1" disabled={busy} value={dayLimit} onChange={e => setDayLimit(e.target.value)} /></label>
                  <div><button className="btn" disabled={busy || !/^[1-9]\d*$/.test(tenMinuteLimit) || !/^[1-9]\d*$/.test(dayLimit) || Number(tenMinuteLimit) > 1000 || Number(dayLimit) > 1000 || (Number(tenMinuteLimit) === info.settings.permitRequestLimits.tenMinutes && Number(dayLimit) === info.settings.permitRequestLimits.day)} onClick={() => void save({ permitRequestLimits: { tenMinutes: Number(tenMinuteLimit), day: Number(dayLimit) } })}>Save limits</button></div>
                </SettingItem>}
                {p && <SettingItem id="controllerApprovesPermits">
                  <label className="opt"><input type="checkbox" disabled={busy} checked={p.controllerCanApprovePermits} onChange={e => e.target.checked ? setConfirmPermits(true) : void save({ controllerCanApprovePermits: false })} /> The controller may approve low risk suggestions</label>
                  <div className="sub">Taskboard checks every step. The controller cannot approve network use, deletion, Git history changes, or commands with unknown effects.</div>
                  {confirmPermits && <div className="banner" role="alert"><p>The controller can approve low risk commands on its own judgment. High risk commands need your explicit words in its chat.</p><div className="ap-a"><button className="btn primary" disabled={busy} onClick={() => { void save({ controllerCanApprovePermits: true, confirmLowerControl: true }); setConfirmPermits(false); }}>Allow controller approval</button><button className="btn" onClick={() => setConfirmPermits(false)}>Cancel</button></div></div>}
                </SettingItem>}
                {p && <SettingItem id="holdPermissionHook">
                  <label className="opt"><input type="checkbox" disabled={busy} checked={p.holdPermissionHook !== false} onChange={e => void save({ holdPermissionHook: e.target.checked })} /> Answer Claude Code permission questions on the Waiting page</label>
                  <div className="sub">Claude Code's permission hook waits up to 30 minutes for your answer on the Waiting page. The question also stays in the terminal, and an answer there closes the card. When this is off, Taskboard reads these questions from the screen and answers with keys.</div>
                </SettingItem>}
                {info && <SettingItem id="confirmRisk">
                  <div className="opt">Ask again before Taskboard sends a risky answer on a waiting card</div>
                  {CONFIRM_RISK_ROWS.map(([key, text]) => <label key={key} className="opt"><input type="checkbox" disabled={busy} checked={{ ...DEFAULT_CONFIRM_RISK, ...info.settings.confirmRisk }[key]} onChange={e => void save({ confirmRisk: { [key]: e.target.checked } })} /> {text}</label>)}
                  <div className="sub">The option always shows its risk on the card. Without this step, one click sends the answer. The controller can never choose these options.</div>
                </SettingItem>}
                {info && <SettingItem id="permitFolders">
                  <label className="opt" htmlFor="permit-folders">Extra folders for permit steps</label>
                  <textarea id="permit-folders" rows={3} value={permitFolders} onChange={e => setPermitFolders(e.target.value)} placeholder="One absolute path per line" />
                  <div className="sub">A permit card names the working folder. The server runs approved commands in your shell.</div>
                  <div><button className="btn" disabled={busy || permitFolders === (info.settings.permitFolders || []).join('\n')} onClick={() => void save({ permitFolders: permitFolders.split('\n').map(p => p.trim()).filter(Boolean) })}>Save folders</button></div>
                </SettingItem>}
              </SettingGroup>
            </SettingSection>

            <SettingSection id="pushes">
              <SettingGroup section="pushes" id="pushes">
                {info && <>
                  <SettingItem id="pushTaskBranches">
                    <label className="opt">Pushes of task branches to my own repositories <select disabled={busy} value={info.settings.pushes.taskBranches === 'never' ? 'never' : 'ask'} onChange={e => void save({ pushTaskBranches: e.target.value as 'ask' | 'never' })}><option value="ask">Ask with a card</option><option value="never">Never</option></select></label>
                    <div className="sub">Every push needs your approval on a card. Taskboard checks the signed-in GitHub account.</div>
                  </SettingItem>
                  <SettingItem id="ownRepositories">
                    <label className="opt" htmlFor="own-repos">Other repositories I own, one owner/repository per line</label>
                    <textarea id="own-repos" rows={3} value={ownRepositories} onChange={e => setOwnRepositories(e.target.value)} />
                    <div><button className="btn" disabled={busy} onClick={() => void save({ ownRepositories: ownRepositories.split('\n').map(s => s.trim()).filter(Boolean) })}>Save repositories</button></div>
                  </SettingItem>
                  <SettingItem id="protectedBranches">
                    <label className="opt" htmlFor="protected-branches">Extra protected branches, one per line</label>
                    <textarea id="protected-branches" rows={3} value={protectedBranches} onChange={e => setProtectedBranches(e.target.value)} />
                    <div><button className="btn" disabled={busy} onClick={() => void save({ protectedBranches: protectedBranches.split('\n').map(s => s.trim()).filter(Boolean) })}>Save branches</button></div>
                  </SettingItem>
                  <SettingItem id="pushHistory">
                    <div className="opt">Push history</div>
                    {pushes.length ? pushes.map(item => <div key={item.id} className="sub">{new Date(item.at).toLocaleString()} · {tasks.find(t => t.id === item.taskId)?.title || item.taskId} · {item.remote}/{item.branch} · {item.oldHead?.slice(0, 8) || 'new'} → {item.newHead.slice(0, 8)} · {item.state}{item.result ? ` · ${item.result}` : ''}</div>) : <div className="sub">No pushes yet.</div>}
                  </SettingItem>
                </>}
              </SettingGroup>
            </SettingSection>

            <SettingSection id="controller">
              <SettingGroup section="controller" id="controller" bare><ControllerBox ctl={ctl} setErr={setErr} /></SettingGroup>
            </SettingSection>

            <SettingSection id="server">
              <SettingGroup section="server" id="restart"><RestartBox /><ServerStarts /></SettingGroup>
              <SettingGroup section="server" id="processes" title="Processes"><Processes /></SettingGroup>
            </SettingSection>

            <SettingSection id="accounts">
              <SettingGroup section="accounts" id="accounts" title="Agents and accounts">
                {info && <SettingItem id="defaultMaxParallel">
                  <label className="opt">Default maximum tasks per account <MaxTasksInput value={info.settings.accounts.defaultMaxParallel} disabled={busy} label="Default maximum number of tasks for an account you add" onSave={async n => { setInfo(await api.updateInfo({ defaultMaxParallel: n })); }} /></label>
                  <div className="sub">An account that you add on the Accounts page starts with this maximum number of running tasks. The accounts that exist now keep their own maximum. Change one account on the Accounts page, or apply this value to all of them.</div>
                  {!applyAll
                    ? <div><button className="btn" disabled={busy} onClick={() => setApplyAll(true)}>Apply to all accounts…</button></div>
                    : <div className="banner">
                      <b>Set the maximum of all {accts.length} accounts to {info.settings.accounts.defaultMaxParallel} tasks?</b>
                      <span className="sub">Now: {accts.map(a => `${a.name} ${a.maxParallel}`).join(', ')}. Running tasks keep running. When more tasks run on an account than its new maximum, Taskboard refuses new tasks on it until fewer run.</span>
                      <button className="btn primary" disabled={busy} onClick={async () => { await save({ applyMaxParallelToAll: true }); setApplyAll(false); loadAccounts().then(setAccts).catch(() => {}); }}>Apply to all accounts</button>
                      <button className="btn" onClick={() => setApplyAll(false)}>Cancel</button>
                    </div>}
                  <div className="sub">Only you can change these maximums, on this page and the Accounts page. <code>tb</code>, agents and the controller cannot.</div>
                </SettingItem>}
              </SettingGroup>
              <SettingGroup section="accounts" id="routing" title="Task routing">
                <SettingItem id="routingRules">
                  <label className="opt" htmlFor="routing-rules">Rules for choosing an agent and account</label>
                  <textarea id="routing-rules" maxLength={1000} value={routingRules} onChange={e => setRoutingRules(e.target.value)} rows={5} />
                  <div className="sub">The controller reads these rules when it starts. A user request can choose an agent or account.</div>
                  <div><button className="btn" disabled={busy || routingRules === info?.settings.routingRules} onClick={() => save({ routingRules })}>Save routing rules</button></div>
                </SettingItem>
              </SettingGroup>
            </SettingSection>

            <SettingSection id="sessions">
              <SettingGroup section="sessions" id="start">
                {p && <>
                  <SettingItem id="trustWorkspaces"><label className="opt"><input type="checkbox" disabled={busy} checked={p.trustWorkspaces} onChange={e => save({ trustWorkspaces: e.target.checked })} /> Trust each task folder before an agent starts</label></SettingItem>
                  <SettingItem id="autoReview">
                    <label className="opt"><input type="checkbox" disabled={busy} checked={p.autoReview} onChange={e => save({ autoReview: e.target.checked })} /> Review tool requests automatically</label>
                    <div className="sub">Claude Code and Codex use their own auto review. Taskboard reviews Antigravity tool calls with the account below. A reviewer can still ask you.</div>
                  </SettingItem>
                  {info && <>
                    <SettingItem id="reviewAccount"><label className="opt">Review account <select disabled={busy || !p.autoReview} value={info.settings.review.account} onChange={e => save({ reviewAccount: e.target.value })}>{accts.filter(a => a.agent === 'claude').map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label></SettingItem>
                    <SettingItem id="reviewModel"><label className="opt">Review model <select disabled={busy || !p.autoReview} value={info.settings.review.model} onChange={e => save({ reviewModel: e.target.value })}><option value="sonnet">Sonnet</option><option value="opus">Opus</option></select></label></SettingItem>
                  </>}
                  <div className="sub">Claude Code and Codex use these choices when they start or resume. Antigravity uses the current review choice for each tool call. Taskboard keeps the command guard on.</div>
                </>}
              </SettingGroup>
              <SettingGroup section="sessions" id="ask" title="BTW: side questions about a session" help={<>The <b>BTW</b> button in a Canvas window asks a separate agent a side question about a session. It reads the terminal and transcript. The session's own agent does not see the question. Claude Code questions have a $0.50 limit. Codex questions use the selected account's usage.</>}>
                {info && <>
                  <SettingItem id="askAgent"><label className="opt">Agent <select disabled={busy} value={info.settings.ask.agent} onChange={e => save({ askAgent: e.target.value as 'claude' | 'codex' })}>
                    <option value="claude">Claude Code</option><option value="codex">Codex</option><option value="antigravity" disabled>Antigravity (read-only access not verified)</option>
                  </select></label></SettingItem>
                  <SettingItem id="askAccount"><label className="opt">Account <select disabled={busy} value={info.settings.ask.account} onChange={e => save({ askAccount: e.target.value })}>{accts.filter(a => a.agent === info.settings.ask.agent).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label></SettingItem>
                  <SettingItem id="askModel">{info.settings.ask.agent === 'claude'
                    ? <label className="opt">Model <select disabled={busy} value={info.settings.ask.model} onChange={e => save({ askModel: e.target.value })}>{['sonnet', 'haiku', 'opus'].map(m => <option key={m} value={m}>{m[0].toUpperCase() + m.slice(1)}</option>)}</select></label>
                    : <label className="opt">Model <input key={info.settings.ask.agent + info.settings.ask.account} disabled={busy} defaultValue={info.settings.ask.model} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} onBlur={e => { const model = e.target.value.trim(); if (model && model !== info.settings.ask.model) save({ askModel: model }); }} /></label>}</SettingItem>
                  <div className="sub">Antigravity does not offer a verified read-only BTW process with MCP servers disabled.</div>
                </>}
              </SettingGroup>
              <AgentErrorSettings info={info} accts={accts} busy={busy} save={save} />
            </SettingSection>

            <SettingSection id="taskBrowsers">
              <TaskBrowserSettings info={info} busy={busy} save={save} />
            </SettingSection>

            <SettingSection id="messages">
              <Integrations />
              <MessageLevels />
            </SettingSection>

            <SettingSection id="rules">
              <RulesFiles />
            </SettingSection>

            <SettingSection id="browser">
              <SettingGroup section="browser" id="canvas" title="Canvas">
                <SettingItem id="confirmEnd">
                  <label className="opt" title="The ⏻ button in a canvas window's header ends the tmux session and archives the task"><input type="checkbox" checked={askEnd} onChange={e => { setConfirmEnd(e.target.checked); setAskEnd(e.target.checked); }} /> Ask before ⏻ in a window header ends and archives the task</label>
                  <div className="sub">Saved for this app or browser. When it is off, ⏻ acts at once and a message offers Restore.</div>
                </SettingItem>
              </SettingGroup>
              <SettingGroup section="browser" id="cardAlerts" title="Notifications">
                <SettingItem id="cardNotify">
                  <label className="opt"><input type="checkbox" checked={notifyCards} onChange={e => { const on = e.target.checked; setCardNotify(on); setNotifyCards(on); if (on && typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission(); }} /> Desktop notification when a card arrives and this window does not have focus</label>
                  <div className="sub">For a new or changed approval card or question card. Saved for this app or browser. Off by default.{typeof Notification !== 'undefined' && Notification.permission === 'denied' ? ' Notifications are blocked for this page in the browser or system settings.' : ''}</div>
                </SettingItem>
                <SettingItem id="cardSound">
                  <label className="opt"><input type="checkbox" checked={soundCards} onChange={e => { setCardSound(e.target.checked); setSoundCards(e.target.checked); }} /> Sound when a card arrives and this window does not have focus</label>
                  <div className="sub">Two short tones. Saved for this app or browser. Off by default.</div>
                </SettingItem>
              </SettingGroup>
              <SettingGroup section="browser" id="controllerView" title="Controller view">
                <SettingItem id="controllerGlass">
                  <div className="opt" title="The controller panel floats over the page. Above 0%, the page behind it shows through, blurred">See-through controller terminal</div>
                  <GlassControls g={glass} r={readable} />
                  <div className="sub">Saved for this app or browser. The ◐ control on the controller bar changes the same setting.</div>
                </SettingItem>
                {windowSeeSupported() && <SettingItem id="windowSee">
                  <label className="opt" title="While the controller view is open, the whole window is drawn see-through, so the desktop behind it shows"><input type="checkbox" checked={winSee.on} onChange={e => { setWindowSee({ on: e.target.checked }); setWinSeeState(windowSee()); }} /> Window see-through while the controller view is open</label>
                  {winSee.on && <label className="glass-row"><span>Window opacity</span><input type="range" min={40} max={95} step={5} value={winSee.opacity} onChange={e => { setWindowSee({ opacity: Number(e.target.value) }); setWinSeeState(windowSee()); }} /><b>{winSee.opacity}%</b></label>}
                  <div className="sub">Saved for this app. Off at first. The whole window, text too, is drawn at this opacity.</div>
                </SettingItem>}
                <SettingItem id="taskInfoDefault">
                  <label className="opt" htmlFor="task-info-default">Details of a task panel when you open it</label>
                  <select id="task-info-default" className="acct-sel" value={infoDef} onChange={e => { const v = e.target.value as InfoDefault; setInfoDefault(v); setInfoDef(v); }}>
                    <option value="auto">Open when the task waits on you or has a notice, else folded</option>
                    <option value="open">Always open</option>
                    <option value="closed">Always folded</option>
                  </select>
                  <div className="sub">The bar above the tabs folds the details: chips, notices, goal and now, links and buttons. A task that you opened or folded keeps your choice. Saved for this app or browser.</div>
                </SettingItem>
              </SettingGroup>
              <SettingGroup section="browser" id="updates" title="Updates">
                <SettingItem id="autoReload">
                  <label className="opt" title="After a release (pnpm release), open Taskboard windows reload themselves and keep their place (page, canvas view, open task)"><input type="checkbox" checked={reloadOn} onChange={e => { setAutoReload(e.target.checked); setReloadOn(e.target.checked); }} /> Reload automatically when Taskboard is updated</label>
                  <div className="sub">Saved for this app or browser. When it is off, a bar offers the reload instead.</div>
                </SettingItem>
              </SettingGroup>
              <SettingGroup section="browser" id="performance" title="Performance">
                <SettingItem id="termWebgl">
                  <label className="opt" title="The GPU draws the text of each terminal. Off: the browser draws each row as page elements, which uses more CPU with fast output"><input type="checkbox" checked={webgl} onChange={e => setWebglOn(e.target.checked)} /> Draw terminals with WebGL</label>
                  <div className="sub">Saved for this app or browser. Open terminals switch at once. If a terminal stays blank, turn this off and tell the controller.</div>
                </SettingItem>
                <SettingItem id="perfMonitor">
                  <label className="opt" title="A small box at the bottom left: long tasks of this page, socket messages, the server's event loop delay, and the load and swap of the machine"><input type="checkbox" checked={perfShown} onChange={e => setPerfOn(e.target.checked)} /> Show the performance monitor</label>
                  <div className="sub">Saved for this app or browser. When the machine is overloaded, it names the three processes with the most CPU and the most memory. It never stops a process.</div>
                </SettingItem>
              </SettingGroup>
            </SettingSection>

            <SettingSection id="keys">
              <KeySettings query={query} />
            </SettingSection>
          </div>
        </div>
      </SettingsFilterProvider>
    </div>
  );
}

// Restart the installed Taskboard server (POST /api/restart runs scripts/restart.mjs). The box first shows what a
// restart does to running tasks; work that it stops needs a second click. The page reconnects by itself afterwards.
function RestartBox() {
  const [impact, setImpact] = useState<RestartImpact | null>(null);
  const [last, setLast] = useState<RestartResult | null>(null);
  const [state, setState] = useState<'idle' | 'checking' | 'restarting'>('idle');
  const [err, setErr] = useState('');
  useEffect(() => { api.restartLast().then(setLast).catch(() => {}); }, []);
  const check = async () => { setErr(''); setState('checking'); try { setImpact(await api.restartCheck()); } catch (e) { setErr(String((e as Error).message || e)); } setState('idle'); };
  const go = async () => {
    setErr(''); setState('restarting');
    try { await api.restartTaskboard(true); } catch (e) { setErr(String((e as Error).message || e)); setState('idle'); return; }
    // wait for the new server, then show the script's result
    const started = Date.now();
    const poll = async () => {
      const r = await api.restartLast().catch(() => null);
      if (r && Date.parse(r.at) >= started) { setLast(r); setImpact(null); setState('idle'); return; }
      if (Date.now() - started > 120000) { setErr('No result after 2 minutes. Read ~/.taskboard/restart.log.'); setState('idle'); return; }
      setTimeout(() => void poll(), 2000);
    };
    setTimeout(() => void poll(), 3000);
  };
  const stops = impact ? impact.stops.length > 0 || impact.tmuxStops : false;
  return <SettingItem id="restartServer">
    <div className="ctl-box set-card">
      <div><b>Restart Taskboard</b></div>
      <div className="sub">Stops this server and starts the installed release again. It does not build or release code. You can also run <code>tb restart</code> in a terminal.</div>
      {err && <div className="banner" role="alert">{err}</div>}
      {!impact && <div><button className="btn" disabled={state !== 'idle'} onClick={() => void check()}>{state === 'checking' ? 'Checking…' : 'Restart Taskboard…'}</button></div>}
      {impact && <div className={stops ? 'banner' : ''} role={stops ? 'alert' : undefined}>
        <p>{impact.tmuxStops ? `The tmux server of the agents is in Taskboard's process group. A restart can stop all ${impact.sessions.length} agent sessions.` : `${impact.sessions.length} agent session${impact.sessions.length === 1 ? '' : 's'} keep running in tmux.`}</p>
        {impact.sessions.length > 0 && <details><summary className="sub">Running agents</summary><ul>{impact.sessions.map(s => <li key={s.num}>#{s.num} {s.title} · {s.status}</li>)}</ul></details>}
        {impact.stops.length > 0 && <><p>A restart stops this work:</p><ul>{impact.stops.map((s, i) => <li key={i}>#{s.num} {s.title}: {s.what}</li>)}</ul></>}
        {impact.notes.map((n, i) => <p key={i} className="sub">{n}</p>)}
        <div className="ap-a">
          <button className="btn primary" disabled={state !== 'idle'} onClick={() => void go()}>{state === 'restarting' ? 'Restarting…' : stops ? 'Restart and stop this work' : 'Restart now'}</button>
          <button className="btn" disabled={state === 'restarting'} onClick={() => setImpact(null)}>Cancel</button>
        </div>
      </div>}
      {last && <div className="sub">Last restart {new Date(last.at).toLocaleString()}: {last.message.split('\n')[0]}</div>}
    </div>
  </SettingItem>;
}

// When and why the server started, and its last 10 starts (GET /api/server, server/server-life.ts).
function ServerStarts() {
  const [h, setH] = useState<ServerHealth | null>(null);
  const { server } = useStore();
  useEffect(() => { api.serverHealth().then(setH).catch(() => {}); }, [server?.startedAt]);
  const when = (at?: string) => at ? new Date(at).toLocaleString() : '';
  const up = (s: number) => s >= 86400 ? `${Math.floor(s / 86400)} d ${Math.floor(s % 86400 / 3600)} h` : s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor(s % 3600 / 60)} min` : `${Math.floor(s / 60)} min`;
  return <SettingItem id="serverStarts">
    <div className="ctl-box set-card">
      <div><b>Server starts</b></div>
      <div className="sub">The server runs as the login service <code>com.taskboard.server</code> (launchd), not inside the Taskboard app. Quitting the app does not stop the server or the agents. launchd starts the server again about 10 s after it ends. The log is <code>~/.taskboard/server.log</code>.</div>
      {!h ? <div className="sub">No start data. An older server does not record it.</div> : <>
        {h.loginService && <p>Starts at login: {h.loginService.startsAtLogin ? 'yes' : 'no'}. Loaded: {h.loginService.loaded ? 'yes' : 'no'}{h.loginService.loaded && !h.loginService.runsThisServer ? ' (it does not run this server process)' : ''}. Last start: {when(h.startedAt)}.</p>}
        <p>Process {h.pid}, release {h.release}. Started {when(h.startedAt)}, up {up(h.uptimeSec)}. The previous server ended: {reasonText(h.previous?.kind)}{h.previous?.detail ? ` (${h.previous.detail})` : ''}.</p>
        <p className="sub">In the last {Object.values(h.counts).reduce((a, b) => a + b, 0)} ends: {h.planned} planned (release, rollback or restart), {h.counts.crash} crash{h.counts.crash === 1 ? '' : 'es'}, {h.counts.signal} other stop signal{h.counts.signal === 1 ? '' : 's'}, {h.counts.unknown} without a log entry. Errors this server survived: {h.recovered.count}{h.recovered.last ? ` (last ${when(h.recovered.last.at)}: ${h.recovered.last.line})` : ''}.</p>
        <table className="starts"><thead><tr><th>Started</th><th>Process</th><th>Release</th><th>Ended</th><th>Reason</th></tr></thead><tbody>
          {h.starts.map(s => <tr key={s.pid + s.startedAt}><td>{when(s.startedAt)}</td><td>{s.pid}</td><td>{s.release}</td><td>{s.end ? when(s.end.at) : s.pid === h.pid ? 'running' : ''}</td><td>{s.end ? `${reasonText(s.end.kind)}${s.end.detail ? `: ${s.end.detail}` : ''}` : ''}</td></tr>)}
        </tbody></table>
      </>}
    </div>
  </SettingItem>;
}

// Keyboard shortcuts: every action in keys.ts with its keys. ＋ waits for the next key and adds it; × removes a key.
// A search that matches only some action names shows only those actions.
const MODES: { value: BrowserMode; label: string }[] = [
  { value: 'task', label: 'Task browser added' },
  { value: 'only', label: 'Task browser only' },
  { value: 'off', label: 'Off: no task browser' },
];
function TaskBrowserSettings({ info, busy, save }: { info: MachineInfo | null; busy: boolean; save: (p: { browserClaude?: BrowserMode; browserCodex?: BrowserMode; chromePath?: string; browserIdleStopMinutes?: number; browserSharp?: boolean; browserScale?: 'screen' | 'one' | 'two'; browserAutoSwitch?: boolean; claudeInChromeTasks?: boolean; claudeInChromeController?: boolean }) => Promise<void> }) {
  const [tpl, setTpl] = useState<BrowserStatus | null>(null);
  const [chrome, setChrome] = useState('');
  const [idle, setIdle] = useState('');
  const [open, setOpen] = useState(false);
  const [tplErr, setTplErr] = useState('');
  useEffect(() => { setChrome(info?.settings.browser?.chromePath || ''); }, [info?.settings.browser?.chromePath]);
  useEffect(() => { setIdle(String(info?.settings.browser?.idleStopMinutes ?? 10)); }, [info?.settings.browser?.idleStopMinutes]);
  useEffect(() => { const load = () => api.browserTemplate().then(setTpl).catch(() => {}); void load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, []);
  const b = info?.settings.browser;
  const check = tpl?.check;
  return <>
    <SettingGroup section="taskBrowsers" id="agents" title="Agents" help={<>Each task gets its own headless Chrome, shown in the task's Browser tab. Agents use it through the MCP server <code>task-browser</code>. A change reaches an agent when its session starts or resumes. Antigravity keeps its own browser.</>}>
      {b && <>
        <SettingItem id="browserClaude"><label className="opt">Browser for Claude Code tasks <select disabled={busy} value={b.claude} onChange={e => void save({ browserClaude: e.target.value as BrowserMode })}>{MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</select></label>
          <div className="sub">"Task browser only" always starts Claude Code with <code>--no-chrome</code>. In the other modes, the setting "Claude in Chrome for Claude Code tasks" decides.</div></SettingItem>
        <SettingItem id="browserCodex"><label className="opt">Browser for Codex tasks <select disabled={busy} value={b.codex} onChange={e => void save({ browserCodex: e.target.value as BrowserMode })}>{MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</select></label>
          <div className="sub">"Task browser only" turns off the Codex feature <code>browser_use_external</code> (ChatGPT for Chrome) for the task.</div></SettingItem>
        <SettingItem id="claudeInChromeTasks"><label className="opt">Claude in Chrome for Claude Code tasks <select disabled={busy} value={info?.settings.claudeInChrome?.tasks ? 'on' : 'off'} onChange={e => void save({ claudeInChromeTasks: e.target.value === 'on' })}><option value="off">Off</option><option value="on">On</option></select></label>
          <div className="sub">Claude in Chrome is the Claude extension in your own Chrome, with your sign-ins. Off: tasks start with <code>--no-chrome</code>, so Claude Code does not ask "Claude in Chrome extension detected" at start. On: Claude Code can ask once, and the answer is saved in the account. A change reaches a task when its session starts or resumes. Default: Off.</div></SettingItem>
        <SettingItem id="claudeInChromeController"><label className="opt">Claude in Chrome for the controller <select disabled={busy} value={info?.settings.claudeInChrome?.controller ? 'on' : 'off'} onChange={e => void save({ claudeInChromeController: e.target.value === 'on' })}><option value="off">Off</option><option value="on">On</option></select></label>
          <div className="sub">Off: the controller starts with <code>--no-chrome</code> and has no <code>claude-in-chrome</code> tools. On: the controller can use your own Chrome. A change restarts the controller between turns. Default: Off.</div></SettingItem>
        <SettingItem id="chromePath">
          <label className="opt" htmlFor="chrome-path">Chrome program</label>
          <input id="chrome-path" value={chrome} onChange={e => setChrome(e.target.value)} placeholder={tpl?.chrome || 'The path of the Chrome program'} spellCheck={false} />
          <div className="sub">Empty: the installed Google Chrome. Found now: {check?.chrome || 'no Chrome'}. Node for the MCP server: {check?.node || 'none found (needs Node 20.19 or 22.12 or newer)'}{check && !check.mcp ? '. The MCP server package is missing: run pnpm install.' : ''}.</div>
          <div><button className="btn" disabled={busy || chrome === (b.chromePath || '')} onClick={() => void save({ chromePath: chrome.trim() })}>Save</button></div>
        </SettingItem>
        <SettingItem id="browserIdleStop">
          <label className="opt" htmlFor="browser-idle">Stop an unused task browser after</label>
          <div><input id="browser-idle" type="number" min={0} max={1440} step={1} style={{ width: '6em' }} value={idle} onChange={e => setIdle(e.target.value)} /> minutes <button className="btn" disabled={busy || idle === '' || Number(idle) === (b.idleStopMinutes ?? 10)} onClick={() => void save({ browserIdleStopMinutes: Number(idle) })}>Save</button></div>
          <div className="sub">A task browser stops when no agent sends it a command and no one views it on the dashboard for this time. Its pages are saved. The next tool call of the agent starts it again with the same pages, in a few seconds. 0 means never stop. Default: 10.</div>
        </SettingItem>
        <SettingItem id="browserSharp">
          <label className="opt" htmlFor="browser-scale">Picture of the Browser tab</label>
          <div><select id="browser-scale" disabled={busy} value={b.scale || (b.sharp ? 'two' : 'screen')} onChange={e => void save({ browserScale: e.target.value as 'screen' | 'one' | 'two' })}>
            <option value="screen">Match the pixel density of this screen</option>
            <option value="one">One pixel for each point</option>
            <option value="two">Two pixels for each point</option>
          </select></div>
          <div className="sub">A task browser starts with this many pixels for each point. On a high-density screen, more pixels make text in the Browser tab sharp. The view then gets more data (about 2.4 times more at two pixels), and agent screenshots are larger and use more tokens. A browser that runs now changes at its next start: its More menu offers the restart. Default: match the screen.</div>
        </SettingItem>
        <SettingItem id="browserAutoSwitch">
          <label className="opt"><input type="checkbox" disabled={busy} checked={b.autoSwitch !== false} onChange={e => void save({ browserAutoSwitch: e.target.checked })} /> Switch to new tabs and popups automatically</label>
          <div className="sub">On: the Browser tab shows a popup (a sign-in window, window.open, a link that opens a new tab) and a tab that an agent opens as soon as it opens, and goes back when the popup closes. A tab that you open in the background (middle click, or ⌘ click) stays in the background. Off: the tab strip shows a button for the new tab. The More menu of a browser changes this for that browser only. Default: on.</div>
        </SettingItem>
      </>}
    </SettingGroup>
    <SettingGroup section="taskBrowsers" id="template" title="Template profile">
      <SettingItem id="templateBrowser">
        <div className="opt">Template browser for sign-ins</div>
        <div className="sub">Sign in here to the sites that agents need. Each new task browser copies this profile when it first starts. Every agent can use the accounts in it, so add only those accounts. Close the template browser before new task browsers start, because Chrome locks an open profile.</div>
        <div className="sub">{tpl ? (tpl.headed ? 'Open in a Chrome window now. Sign in there, then quit that Chrome window (Chrome menu, Quit Google Chrome).' : tpl.running ? `Open now (${tpl.tabs.length} tab(s)).` : tpl.profile ? 'Closed. The profile exists.' : 'No template profile yet.') : '…'}</div>
        <div className="si-row">
          <button className="btn" disabled={!!tpl?.headed} onClick={() => setOpen(o => !o)}>{open ? 'Hide the template browser' : 'Show the template browser'}</button>
          {tpl?.headed
            ? <button className="btn" onClick={() => void api.browserTemplateAction('stop').then(setTpl).catch(e => setTplErr(String(e.message || e)))}>Close the Chrome window</button>
            : <button className="btn" onClick={() => { setOpen(false); void api.templateWindow().then(setTpl).catch(e => setTplErr(String(e.message || e))); }} title="Opens the template profile in a normal Chrome window, without headless mode and without the debugging port">Sign in with a normal Chrome window</button>}
        </div>
        <div className="sub">Google and some other sites refuse a sign-in in a browser that a program controls. Google then shows "Error 500" or "Couldn't sign you in". The task browsers run headless with a debugging port, so they report HeadlessChrome and navigator.webdriver. The normal Chrome window has neither. Taskboard does not see or control that window.</div>
        <div className="sub">To sign in to Google once for all task browsers:</div>
        <ol className="sub si-steps">
          <li>Click Sign in with a normal Chrome window. A Chrome window opens on the Google sign-in page.</li>
          <li>Sign in there with your account.</li>
          <li>Quit that Chrome (Chrome menu, Quit Google Chrome). Closing the tab is not enough.</li>
          <li>New task browsers copy the sign-in. For a task browser that exists now, click Sync sign-ins from the template in its More menu (the ... button).</li>
        </ol>
        <div className="sub">A task browser on a Google sign-in page also shows a Sign in in a normal window button. It opens the same window, and after you quit it, that task browser gets the sign-in.</div>
        {tplErr && <div className="banner">{tplErr}</div>}
        {open && !tpl?.headed && <div className="tpl-browser"><BrowserView id="template" title="Template browser" isTemplate /></div>}
      </SettingItem>
      <SettingItem id="signinSharing">
        <div className="opt">Sign-in sharing</div>
        <SigninSettings />
      </SettingItem>
    </SettingGroup>
  </>;
}

function KeySettings({ query }: { query: string }) {
  useKeymap();
  const [adding, setAdding] = useState<string | null>(null);
  useEffect(() => {
    if (!adding) return;
    setRecording(true);
    const on = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.code === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) { setAdding(null); return; }
      const c = comboOf(e); if (!c) return; // a modifier key alone: wait for the rest
      if (!keysOf(adding).includes(c)) setKeys(adding, [...keysOf(adding), c]);
      setAdding(null);
    };
    addEventListener('keydown', on, true);
    return () => { removeEventListener('keydown', on, true); setRecording(false); };
  }, [adding]);
  // a key set for two actions: in the same place both would run; an Anywhere key gives way to the page's own key
  const users = new Map<string, KeyAction[]>();
  ACTIONS.forEach(a => keysOf(a.id).forEach(k => users.set(k, [...(users.get(k) || []), a])));
  const note = (a: KeyAction, k: string) => {
    const other = (users.get(k) || []).filter(b => b.id !== a.id && (b.ctx === a.ctx || b.ctx === 'app' || a.ctx === 'app'));
    const same = other.filter(b => b.ctx === a.ctx);
    if (same.length) return { warn: true, text: `Also set for “${same[0].label}”. Only one of them runs.` };
    if (other.length) return { warn: false, text: a.ctx === 'app' ? `On the ${CTX_NAME[other[0].ctx]} it does “${other[0].label}” instead.` : `Takes the place of “${other[0].label}” here.` };
    if (/^Ctrl\+(Shift\+)?Key/.test(k)) return { warn: true, text: 'Control + letter is also a terminal key. The terminal does not get it.' };
    return null;
  };
  const test = matcher(query);
  const rows = test && !test(settingText('keyboardShortcuts')) ? ACTIONS.filter(a => test(`${CTX_NAME[a.ctx]} ${a.label}`)) : ACTIONS;
  let last = '';
  return <SettingGroup section="keys" id="keys" help="Keys with ⌘ or ⌃ work everywhere, also while you type in a terminal. Every ⌃⌥ key goes to Taskboard and not to the terminal. No default key is a single key without ⌘, ⌃ or ⌥, because such a key can run by accident. You can add one: it works only when the cursor is not in a terminal, a text field or the task browser. In the task browser every key goes to the page, except the key that leaves the browser. Saved for this app or browser.">
    <SettingItem id="keyboardShortcuts">
      <div className="set-scroll"><table className="keys keyset"><tbody>{rows.map(a => {
        const head = CTX_NAME[a.ctx] !== last; last = CTX_NAME[a.ctx];
        const notes = keysOf(a.id).map(k => [k, note(a, k)] as const).filter(([, n]) => n);
        return <tr key={a.id} className={head ? 'first' : ''}>
          <td className="sub">{head ? CTX_NAME[a.ctx] : ''}</td>
          <td>{a.label}{notes.map(([k, n]) => <div key={k} className={`keynote ${n!.warn ? 'warn' : ''}`}>{fmtCombo(k)}: {n!.text}</div>)}</td>
          <td className="keycell">
            {keysOf(a.id).map(k => <span key={k} className="keychip"><kbd>{fmtCombo(k)}</kbd><button title="Remove this key" onClick={() => setKeys(a.id, keysOf(a.id).filter(x => x !== k))}>×</button></span>)}
            {adding === a.id ? <span className="keywait">Press a key… (Esc cancels)</span> : <button className="btn ghost keyadd" title="Add a key: click, then press the key" onClick={() => setAdding(a.id)}>＋</button>}
            {isCustom(a.id) && <button className="btn ghost keyadd" title={`Back to ${a.keys.map(fmtCombo).join(' / ') || 'no key'}`} onClick={() => resetKeys(a.id)}>Reset</button>}
          </td>
        </tr>;
      })}</tbody></table></div>
      <div><button className="btn" disabled={!ACTIONS.some(a => isCustom(a.id))} onClick={() => resetKeys()}>Reset all keys</button></div>
    </SettingItem>
  </SettingGroup>;
}

// Settings > Approvals > Allow always rules (server/allow-rules.ts): each rule in plain words, its deliveries, Revoke
// and Revoke all. The list reloads every 15 seconds, so new rules and delivery counts show without a page reload.
function AllowRules({ setErr }: { setErr: (s: string) => void }) {
  const [data, setData] = useState<{ rules: AllowRule[]; limitPerHour: number; limitText: string; builtIn?: BuiltInRule[] } | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const load = () => api.allowRules().then(setData).catch(e => setErr(String((e as Error).message || e)));
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 15000); return () => clearInterval(timer); }, []);
  const act = (p: Promise<unknown>) => void p.then(load).catch(e => setErr(String((e as Error).message || e)));
  if (!data) return <div className="sub">Loading the rules…</div>;
  return (
    <div className="allow-rules">
      <div className="opt">Tasks that may type into other tasks, or send documents to them, without a card</div>
      {(data.builtIn || []).map(b => (
        <div key={b.id} className="allow-rule built-in">
          <div>
            <div>{b.text} <span className="sub">(read only)</span></div>
            <div className="sub">{b.groups.length ? b.groups.map(g => `${g.name}: manager #${g.num ?? g.manager}, ${g.preset}, ${g.tasks} tasks`).join(' · ') : 'No group has a manager now.'}</div>
            <div className="sub">{b.limitText}</div>
          </div>
        </div>
      ))}
      {data.rules.length ? data.rules.map(r => (
        <div key={r.id} className="allow-rule">
          <div>
            <div>{r.text}</div>
            <div className="sub">Rule {r.id} · added {new Date(r.created).toLocaleString()} by you on card {r.card} · {r.count} {r.kind === 'doc' ? 'document' : 'message'}{r.count === 1 ? '' : 's'} delivered · {r.lastHour} of {data.limitPerHour} in the last hour{r.lastAt ? ` · last ${new Date(r.lastAt).toLocaleString()}` : ''}</div>
          </div>
          <button className="btn" onClick={() => act(api.revokeAllowRule(r.id))}>Revoke</button>
        </div>
      )) : <div className="sub">No allow always rule. Every other message from one task to another waits for your card.</div>}
      <div className="sub">{data.limitText} Taskboard removes a rule when one of its tasks is archived or removed.</div>
      {data.rules.length > 0 && (!confirmAll
        ? <div><button className="btn" onClick={() => setConfirmAll(true)}>Revoke all…</button></div>
        : <div className="banner"><b>{data.rules.length === 1 ? 'Revoke the rule?' : `Revoke all ${data.rules.length} rules?`}</b> <span className="sub">Every message between tasks then waits for your card again.</span> <button className="btn primary" onClick={() => { setConfirmAll(false); act(api.revokeAllAllowRules()); }}>Revoke all</button><button className="btn" onClick={() => setConfirmAll(false)}>Cancel</button></div>)}
    </div>
  );
}

// Settings > Agent sessions > Model errors and auto-continue (server/agent-error-watch.ts, machine.ts agentErrors)
function AgentErrorSettings({ info, accts, busy, save }: { info: MachineInfo | null; accts: Account[]; busy: boolean; save: (p: { agentErrors: NonNullable<Parameters<typeof api.updateInfo>[0]['agentErrors']> }) => Promise<void> }) {
  const a = info?.settings.agentErrors;
  const [message, setMessage] = useState('');
  const [stall, setStall] = useState('');
  const [capacityInterval, setCapacityInterval] = useState('60');
  const [capacityRetries, setCapacityRetries] = useState('5');
  useEffect(() => { setMessage(a?.message || 'continue'); }, [a?.message]);
  useEffect(() => { setStall(String(a?.stallMinutes ?? 5)); }, [a?.stallMinutes]);
  useEffect(() => { setCapacityInterval(String(a?.codexCapacity.intervalSeconds ?? 60)); }, [a?.codexCapacity.intervalSeconds]);
  useEffect(() => { setCapacityRetries(String(a?.codexCapacity.maxRetries ?? 5)); }, [a?.codexCapacity.maxRetries]);
  if (!a) return null;
  return <SettingGroup section="sessions" id="agentErrors" title="Model errors and auto-continue" help={<>Taskboard shows when an agent stopped on a model error: the model is overloaded or at capacity, a rate limit, a server error or a lost connection. It reads the Claude Code StopFailure hook, the session file of the agent, and the screen. A task that the agent still retries shows "Retrying" and stays working.</>}>
    <SettingItem id="codexCapacity">
      <label className="opt"><input type="checkbox" disabled={busy} checked={a.codexCapacity.enabled} onChange={e => void save({ agentErrors: { codexCapacity: { enabled: e.target.checked } } })} /> Continue Codex after "Selected model is at capacity"</label>
      <div className="sub">Taskboard retries the same task, account, and model. It stops after the retry count. This setting starts off.</div>
      <div className="opt">Retry every <input aria-label="Codex capacity retry interval in seconds" type="number" min={5} max={3600} step={1} style={{ width: '6em' }} value={capacityInterval} onChange={e => setCapacityInterval(e.target.value)} /> seconds. Stop after <input aria-label="Codex capacity maximum retries" type="number" min={1} max={100} step={1} style={{ width: '5em' }} value={capacityRetries} onChange={e => setCapacityRetries(e.target.value)} /> retries. <button className="btn" disabled={busy || !Number.isInteger(Number(capacityInterval)) || Number(capacityInterval) < 5 || Number(capacityInterval) > 3600 || !Number.isInteger(Number(capacityRetries)) || Number(capacityRetries) < 1 || Number(capacityRetries) > 100 || (Number(capacityInterval) === a.codexCapacity.intervalSeconds && Number(capacityRetries) === a.codexCapacity.maxRetries)} onClick={() => void save({ agentErrors: { codexCapacity: { intervalSeconds: Number(capacityInterval), maxRetries: Number(capacityRetries) } } })}>Save</button></div>
    </SettingItem>
    <SettingItem id="autoContinue">
      <label className="opt"><input type="checkbox" disabled={busy} checked={a.autoContinue} onChange={e => void save({ agentErrors: { autoContinue: e.target.checked } })} /> Auto-continue after a model error</label>
      <div className="sub">On: when an agent stopped on a model error, Taskboard types the message below after 1, 2, 5, 10 and 10 minutes, at most 5 times for one error. It types only into an empty input box. It never types over your draft or into a dialog, and never for a task that waits on a card or a question. It never retries a usage limit, a credit problem, a sign-in problem, a conversation that is too long, or a stall. Each try is an ordinary turn of the agent and uses the same usage as when you type it. Each try is in the task log. Default: Off.</div>
    </SettingItem>
    <SettingItem id="autoContinueMessage">
      <label className="opt" htmlFor="auto-continue-message">Auto-continue message</label>
      <div><input id="auto-continue-message" maxLength={500} value={message} onChange={e => setMessage(e.target.value)} spellCheck={false} /> <button className="btn" disabled={busy || !message.trim() || message.trim() === a.message} onClick={() => void save({ agentErrors: { message: message.trim() } })}>Save</button></div>
      <div className="sub">The Continue button of a stopped task types the same text. Default: continue.</div>
    </SettingItem>
    <SettingItem id="autoContinueAccounts">
      <label className="opt">Auto-continue for each account</label>
      <div className="ae-accounts">{accts.filter(x => x.agent !== 'antigravity').map(x => <label key={x.id} className="opt">{x.name} <select disabled={busy} value={a.accounts[x.id] || 'default'} onChange={e => void save({ agentErrors: { accounts: { [x.id]: e.target.value as 'on' | 'off' | 'default' } } })}>
        <option value="default">Default ({a.autoContinue ? 'on' : 'off'})</option><option value="on">On</option><option value="off">Off</option></select></label>)}</div>
      <div className="sub">A task can set its own value in its error banner. Antigravity tasks are not read for model errors yet.</div>
    </SettingItem>
    <SettingItem id="stallMinutes">
      <label className="opt" htmlFor="stall-minutes">Show a working task as stalled after</label>
      <div><input id="stall-minutes" type="number" min={0} max={240} step={1} style={{ width: '6em' }} value={stall} onChange={e => setStall(e.target.value)} /> minutes <button className="btn" disabled={busy || stall === '' || Number(stall) === a.stallMinutes} onClick={() => void save({ agentErrors: { stallMinutes: Number(stall) } })}>Save</button></div>
      <div className="sub">A task stalls when it says it works, waits for the model, and neither its screen nor its transcript changed for this time. A running tool (a build, a test) never stalls. A stall is inferred, so auto-continue does not act on it. 0 means never. Default: 5.</div>
    </SettingItem>
  </SettingGroup>;
}
