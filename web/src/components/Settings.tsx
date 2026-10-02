// Settings: what the controller and other agents may do without asking, and this machine's controller. The page has
// one section for each entry of SECTIONS in settingsIndex.ts, a side list of those sections and a search box.
import { useEffect, useRef, useState } from 'react';
import type { BrowserMode, BrowserStatus, MachineInfo, MessageLevel, PushRecord, RestartImpact, RestartResult, Task } from '../api';
import { api, autoReload, confirmEnd, setAutoReload, setConfirmEnd } from '../api';
import { GLASS_STEPS, glassStep, setGlassStep, setTaskThinBar, taskThinBar, type GlassId } from '../controllerView';
import { ControllerBox, MaxTasksInput, loadAccounts } from './Accounts';
import { MessageLevels } from './MessageLevels';
import { Integrations } from './Integrations';
import { RulesFiles } from './RulesFiles';
import { BrowserView } from './TaskBrowser';
import type { Account } from './Accounts';
import type { KeyAction } from '../keys';
import { ACTIONS, CTX_NAME, comboOf, fmtCombo, isCustom, keysOf, resetKeys, setKeys, setRecording, useKeymap } from '../keys';
import { filterSettings, matcher, settingText } from '../settingsIndex';
import { SettingGroup, SettingItem, SettingSection, SettingsFilterProvider, SettingsNav, hashSection, sectionAnchor } from './SettingsLayout';

// Search text for the keyboard shortcuts: the name of every action and of its place.
const KEY_SEARCH = { keyboardShortcuts: ACTIONS.map(a => `${CTX_NAME[a.ctx]} ${a.label}`).join('\n') };

export function SettingsPage({ tasks }: { tasks: Task[] }) {
  const [info, setInfo] = useState<MachineInfo | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [reloadOn, setReloadOn] = useState(autoReload());
  const [askEnd, setAskEnd] = useState(confirmEnd());
  const [glass, setGlass] = useState<GlassId>(() => glassStep().id);
  const [thinBar, setThinBar] = useState(taskThinBar);
  const [accts, setAccts] = useState<Account[]>([]);
  const [routingRules, setRoutingRules] = useState('');
  const [applyAll, setApplyAll] = useState(false); // the confirmation for "Apply to all accounts" is open
  const [permitFolders, setPermitFolders] = useState('');
  const [confirmPermits, setConfirmPermits] = useState(false);
  const [pushes, setPushes] = useState<PushRecord[]>([]);
  const [ownRepositories, setOwnRepositories] = useState('');
  const [protectedBranches, setProtectedBranches] = useState('');
  const [query, setQuery] = useState('');
  const pageRef = useRef<HTMLDivElement>(null);
  useEffect(() => { api.info().then(i => { setInfo(i); setRoutingRules(i.settings.routingRules || ''); setPermitFolders((i.settings.permitFolders || []).join('\n')); setOwnRepositories((i.settings.pushes?.ownRepositories || []).join('\n')); setProtectedBranches((i.settings.pushes?.protectedBranches || []).join('\n')); }).catch(e => setErr(String(e.message || e))); loadAccounts().then(setAccts).catch(() => {}); api.pushes().then(setPushes).catch(() => {}); }, []);
  // #settings:<section> opens the page at that section
  useEffect(() => {
    const go = () => { const id = hashSection(); if (id) document.getElementById(sectionAnchor(id))?.scrollIntoView({ block: 'start' }); };
    const timer = setTimeout(go, 50);
    addEventListener('hashchange', go);
    return () => { clearTimeout(timer); removeEventListener('hashchange', go); };
  }, []);
  const save = async (p: { routingRules?: string; controllerNeedsApproval?: boolean; agentsNeedApproval?: boolean; trustWorkspaces?: boolean; autoReview?: boolean; controllerCanApprovePermits?: boolean; holdPermissionHook?: boolean; permitFolders?: string[]; pushTaskBranches?: 'run' | 'ask' | 'never'; ownRepositories?: string[]; protectedBranches?: string[]; askAgent?: 'claude' | 'codex'; askAccount?: string; askModel?: string; reviewAccount?: string; reviewModel?: string; messageIncoming?: MessageLevel; messageOutgoing?: MessageLevel; checkPrivateNotes?: boolean; confirmLowerControl?: boolean; defaultMaxParallel?: number; applyMaxParallelToAll?: boolean; browserClaude?: BrowserMode; browserCodex?: BrowserMode; chromePath?: string }) => {
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
                  <div className="sub">A change reaches the controller when it next restarts, which Taskboard does by itself as soon as the controller is between turns (its conversation continues). Releasing or rolling back Taskboard and stopping its server stay blocked for every agent.</div>
                </>}
              </SettingGroup>
              <SettingGroup section="approvals" id="permits" title="Permit requests">
                {p && <SettingItem id="controllerApprovesPermits">
                  <label className="opt"><input type="checkbox" disabled={busy} checked={p.controllerCanApprovePermits} onChange={e => e.target.checked ? setConfirmPermits(true) : void save({ controllerCanApprovePermits: false })} /> The controller may approve low risk suggestions</label>
                  <div className="sub">Taskboard checks every step. The controller cannot approve network use, deletion, Git history changes, or commands with unknown effects.</div>
                  {confirmPermits && <div className="banner" role="alert"><p>The controller can approve low risk commands on its own judgment. High risk commands need your explicit words in its chat.</p><div className="ap-a"><button className="btn primary" disabled={busy} onClick={() => { void save({ controllerCanApprovePermits: true, confirmLowerControl: true }); setConfirmPermits(false); }}>Allow controller approval</button><button className="btn" onClick={() => setConfirmPermits(false)}>Cancel</button></div></div>}
                </SettingItem>}
                {p && <SettingItem id="holdPermissionHook">
                  <label className="opt"><input type="checkbox" disabled={busy} checked={p.holdPermissionHook !== false} onChange={e => void save({ holdPermissionHook: e.target.checked })} /> Answer Claude Code permission questions on the Waiting page</label>
                  <div className="sub">Claude Code's permission hook waits up to 30 minutes for your answer on the Waiting page. The question also stays in the terminal, and an answer there closes the card. When this is off, Taskboard reads these questions from the screen and answers with keys.</div>
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
              <SettingGroup section="server" id="restart"><RestartBox /></SettingGroup>
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
              <SettingGroup section="browser" id="controllerView" title="Controller view">
                <SettingItem id="controllerGlass">
                  <label className="opt" title="The controller panel floats over the page. With a step above Off, the page behind it shows through, blurred">Transparency of the controller terminal <select value={glass} onChange={e => { setGlassStep(e.target.value as GlassId); setGlass(e.target.value as GlassId); }}>{GLASS_STEPS.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}</select></label>
                  <div className="sub">Saved for this app or browser. The ◐ control on the controller bar changes the same setting.</div>
                </SettingItem>
                <SettingItem id="taskThinBar">
                  <label className="opt" title="The header of a task panel folds to a thin bar with the number, the title and the status, as in the controller view"><input type="checkbox" checked={thinBar} onChange={e => { setTaskThinBar(e.target.checked); setThinBar(e.target.checked); }} /> Fold the header of normal tasks to a thin bar too</label>
                  <div className="sub">Saved for this app or browser. A change applies to the next task panel that you open.</div>
                </SettingItem>
              </SettingGroup>
              <SettingGroup section="browser" id="updates" title="Updates">
                <SettingItem id="autoReload">
                  <label className="opt" title="After a release (pnpm release), open Taskboard windows reload themselves and keep their place (page, canvas view, open task)"><input type="checkbox" checked={reloadOn} onChange={e => { setAutoReload(e.target.checked); setReloadOn(e.target.checked); }} /> Reload automatically when Taskboard is updated</label>
                  <div className="sub">Saved for this app or browser. When it is off, a bar offers the reload instead.</div>
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

// Keyboard shortcuts: every action in keys.ts with its keys. ＋ waits for the next key and adds it; × removes a key.
// A search that matches only some action names shows only those actions.
const MODES: { value: BrowserMode; label: string }[] = [
  { value: 'task', label: 'Task browser, and the shared Chrome extension' },
  { value: 'only', label: 'Task browser only' },
  { value: 'off', label: 'Off: only the agent\'s own browser tools' },
];
function TaskBrowserSettings({ info, busy, save }: { info: MachineInfo | null; busy: boolean; save: (p: { browserClaude?: BrowserMode; browserCodex?: BrowserMode; chromePath?: string; browserIdleStopMinutes?: number; browserSharp?: boolean }) => Promise<void> }) {
  const [tpl, setTpl] = useState<BrowserStatus | null>(null);
  const [chrome, setChrome] = useState('');
  const [idle, setIdle] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => { setChrome(info?.settings.browser?.chromePath || ''); }, [info?.settings.browser?.chromePath]);
  useEffect(() => { setIdle(String(info?.settings.browser?.idleStopMinutes ?? 10)); }, [info?.settings.browser?.idleStopMinutes]);
  useEffect(() => { const load = () => api.browserTemplate().then(setTpl).catch(() => {}); void load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, []);
  const b = info?.settings.browser;
  const check = tpl?.check;
  return <>
    <SettingGroup section="taskBrowsers" id="agents" title="Agents" help={<>Each task gets its own headless Chrome, shown in the task's Browser tab. Agents use it through the MCP server <code>task-browser</code>. A change reaches an agent when its session starts or resumes. Antigravity keeps its own browser.</>}>
      {b && <>
        <SettingItem id="browserClaude"><label className="opt">Browser for Claude Code tasks <select disabled={busy} value={b.claude} onChange={e => void save({ browserClaude: e.target.value as BrowserMode })}>{MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</select></label>
          <div className="sub">"Task browser only" starts Claude Code with <code>--no-chrome</code>, so it cannot use Claude in Chrome in your own Chrome.</div></SettingItem>
        <SettingItem id="browserCodex"><label className="opt">Browser for Codex tasks <select disabled={busy} value={b.codex} onChange={e => void save({ browserCodex: e.target.value as BrowserMode })}>{MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</select></label>
          <div className="sub">"Task browser only" turns off the Codex feature <code>browser_use_external</code> (ChatGPT for Chrome) for the task.</div></SettingItem>
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
          <label className="opt"><input type="checkbox" disabled={busy} checked={!!b.sharp} onChange={e => void save({ browserSharp: e.target.checked })} /> Sharp view on Retina screens</label>
          <div className="sub">Task browsers start with two pixels for each point, so text in the Browser tab is sharp. The view then gets about 2.4 times more data, which can be slow from another computer. Agent screenshots are twice as large and use more tokens. A browser that runs now changes at its next start: stop it and start it again. Default: off.</div>
        </SettingItem>
      </>}
    </SettingGroup>
    <SettingGroup section="taskBrowsers" id="template" title="Template profile">
      <SettingItem id="templateBrowser">
        <div className="opt">Template browser for sign-ins</div>
        <div className="sub">Sign in here to the sites that agents need. Each new task browser copies this profile when it first starts. Every agent can use the accounts in it, so add only those accounts. Close the template browser before new task browsers start, because Chrome locks an open profile.</div>
        <div className="sub">{tpl ? (tpl.running ? `Open now (${tpl.tabs.length} tab(s)).` : tpl.profile ? 'Closed. The profile exists.' : 'No template profile yet.') : '…'}</div>
        <div><button className="btn" onClick={() => setOpen(o => !o)}>{open ? 'Hide the template browser' : 'Show the template browser'}</button></div>
        {open && <div className="tpl-browser"><BrowserView id="template" title="Template browser" isTemplate /></div>}
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
