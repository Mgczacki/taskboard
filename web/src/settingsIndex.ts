// The sections of the Settings page, their groups and their settings, in page order. The side list and the search box
// read this list. Each `label` is the text that the page shows for the setting. `words` adds search terms that are
// not in the label. A section with no settings is hidden.

export interface SettingDef { id: string; label: string; words?: string }
export interface GroupDef { id: string; title?: string; settings: SettingDef[] }
export interface SectionDef { id: string; title: string; help: string; groups: GroupDef[] }

export const SECTIONS: SectionDef[] = [
  { id: 'approvals', title: 'Approvals', help: 'What the controller and other agents can do without your approval.', groups: [
    { id: 'tasks', title: 'Managing tasks', settings: [
      { id: 'controllerManagesTasks', label: 'The controller may create and manage tasks without asking', words: 'tb new send park archive resume approval' },
      { id: 'agentsManageTasks', label: 'Other agents may start, type into, set aside and archive tasks without asking', words: 'tb approval' },
    ] },
    { id: 'controllerApprovals', title: 'Controller approvals', settings: [
      { id: 'controllerApprovalKinds', label: 'Let the controller approve this kind when I ask in the chat', words: 'tb approve merge push force push release restart scope permit message draft chat' },
    ] },
    { id: 'permits', title: 'Permit requests', settings: [
      { id: 'controllerApprovesPermits', label: 'The controller may approve low risk suggestions', words: 'permit approval risk' },
      { id: 'holdPermissionHook', label: 'Answer Claude Code permission questions on the Waiting page', words: 'waiting inbox question hook permission dialog' },
      { id: 'confirmRisk', label: 'Ask again before Taskboard sends a risky answer on a waiting card', words: 'confirm wide access always allow rule installs software credit ends session exit' },
      { id: 'permitFolders', label: 'Extra folders for permit steps', words: 'permit path working folder shell' },
    ] },
  ] },
  { id: 'pushes', title: 'Pushes', help: 'When agents can ask to push task branches, and which repositories and branches Taskboard treats as yours or protected.', groups: [
    { id: 'pushes', settings: [
      { id: 'pushTaskBranches', label: 'Pushes of task branches to my own repositories', words: 'git github ask never' },
      { id: 'ownRepositories', label: 'Other repositories I own, one owner/repository per line', words: 'git github' },
      { id: 'protectedBranches', label: 'Extra protected branches, one per line', words: 'git main master' },
      { id: 'pushHistory', label: 'Push history', words: 'git log' },
    ] },
  ] },
  { id: 'controller', title: 'Controller', help: 'The controller of this machine: its name, its agent, how it starts, its permission prompts, its model and Remote Control.', groups: [
    { id: 'controller', settings: [
      { id: 'machineName', label: 'This machine', words: 'name host' },
      { id: 'controllerAutostart', label: 'Start the controller with Taskboard and keep it running', words: 'autostart restart' },
      { id: 'controllerAgent', label: 'Controller agent', words: 'claude code codex antigravity agy switch agents.md' },
      { id: 'controllerSkipPermissions', label: 'Controller: skip permission prompts', words: '--dangerously-skip-permissions --dangerously-bypass-approvals-and-sandbox dangerously bypass skip permissions prompts approvals sandbox' },
      { id: 'controllerModel', label: 'Controller model for', words: 'model claude codex' },
      { id: 'remoteControl', label: 'Remote Control: reach the controller from the Claude app as', words: 'mobile phone link' },
    ] },
  ] },
  { id: 'server', title: 'Taskboard server', help: 'Restart the installed Taskboard server. Agent sessions keep running in tmux. Quitting the Taskboard app does not stop the server.', groups: [
    { id: 'restart', settings: [
      { id: 'restartServer', label: 'Restart Taskboard', words: 'restart reload server tb restart launchd' },
      { id: 'serverStarts', label: 'Server starts', words: 'uptime crash crashes history start stop reason release quit app launchd login' },
    ] },
    { id: 'processes', title: 'Processes', settings: [
      { id: 'processes', label: 'Processes', words: 'cpu memory energy power top ps htop activity monitor tb# agents chrome tmux' },
    ] },
  ] },
  { id: 'accounts', title: 'Accounts and routing', help: 'The task limit for new accounts, and the rules that the controller uses to choose an agent and an account.', groups: [
    { id: 'accounts', title: 'Agents and accounts', settings: [
      { id: 'defaultMaxParallel', label: 'Default maximum tasks per account', words: 'limit parallel apply to all accounts' },
    ] },
    { id: 'routing', title: 'Task routing', settings: [
      { id: 'routingRules', label: 'Rules for choosing an agent and account', words: 'routing controller' },
    ] },
  ] },
  { id: 'sessions', title: 'Agent sessions', help: 'How agent sessions start, how Taskboard reviews tool requests, and which agent answers questions about a session.', groups: [
    { id: 'start', settings: [
      { id: 'trustWorkspaces', label: 'Trust each task folder before an agent starts', words: 'workspace' },
      { id: 'autoReview', label: 'Review tool requests automatically', words: 'auto review permission' },
      { id: 'reviewAccount', label: 'Review account', words: 'auto review antigravity' },
      { id: 'reviewModel', label: 'Review model', words: 'auto review sonnet opus' },
    ] },
    { id: 'ask', title: 'BTW: side questions about a session', settings: [
      { id: 'askAgent', label: 'Agent', words: 'btw ask side question ? claude codex' },
      { id: 'askAccount', label: 'Account', words: 'btw ask side question ?' },
      { id: 'askModel', label: 'Model', words: 'btw ask side question ? sonnet haiku opus' },
    ] },
  ] },
  { id: 'taskBrowsers', title: 'Task browsers', help: 'The Chrome browser of each task, the template profile that new task browsers copy, and which agents use them.', groups: [
    { id: 'agents', title: 'Agents', settings: [
      { id: 'browserClaude', label: 'Browser for Claude Code tasks', words: 'chrome mcp devtools task browser' },
      { id: 'browserCodex', label: 'Browser for Codex tasks', words: 'chrome mcp devtools chatgpt extension' },
      { id: 'claudeInChromeTasks', label: 'Claude in Chrome for Claude Code tasks', words: 'chrome extension no-chrome dialog detected prompt start' },
      { id: 'claudeInChromeController', label: 'Claude in Chrome for the controller', words: 'chrome extension no-chrome dialog detected prompt controller' },
      { id: 'chromePath', label: 'Chrome program', words: 'path binary chromium executable' },
      { id: 'browserIdleStop', label: 'Stop an unused task browser after', words: 'idle memory minutes timeout close' },
      { id: 'browserSharp', label: 'Sharp view on Retina screens', words: 'retina sharp blurry pixel ratio scale resolution hidpi' },
      { id: 'browserAutoSwitch', label: 'Switch to new tabs and popups automatically', words: 'popup window open login oauth tab focus follow agent new tab' },
    ] },
    { id: 'template', title: 'Template profile', settings: [
      { id: 'templateBrowser', label: 'Template browser for sign-ins', words: 'profile cookies login copy accounts' },
      { id: 'signinSharing', label: 'Sign-in sharing', words: 'shared sign-ins cookies live sync sign out google accounts opt out' },
    ] },
  ] },
  { id: 'messages', title: 'Messages and integrations', help: 'The sign-ins that Taskboard uses, and who approves messages between you, your agents and other people.', groups: [
    { id: 'integrations', title: 'Integrations', settings: [
      { id: 'a2aNotes', label: 'A2A Notes (Slack)', words: 'slack sign-in connect setup integration' },
    ] },
    { id: 'levels', title: 'Messages from other people', settings: [
      { id: 'messageIncoming', label: 'Who lets an incoming message reach your agents', words: 'a2a notes slack level incoming' },
      { id: 'messageOutgoing', label: 'Who approves a message that your agents send', words: 'a2a notes slack level outgoing draft' },
      { id: 'checkBody', label: 'Check drafts for private working notes and internal terms', words: 'a2a notes slack flagged' },
      { id: 'trustedPeople', label: 'Trusted people', words: 'a2a notes slack trust person' },
    ] },
  ] },
  { id: 'rules', title: 'Rules files', help: 'The rules files that the controller and task sessions read.', groups: [
    { id: 'rules', settings: [
      { id: 'controllerRules', label: 'Controller rules', words: 'rules file instructions claude.md agents.md' },
      { id: 'taskRules', label: 'Task session rules', words: 'rules file instructions claude.md agents.md' },
    ] },
  ] },
  { id: 'browser', title: 'This app or browser', help: 'These choices are saved in this app or browser only.', groups: [
    { id: 'canvas', title: 'Canvas', settings: [
      { id: 'confirmEnd', label: 'Ask before ⏻ in a window header ends and archives the task', words: 'end archive confirm power' },
    ] },
    { id: 'controllerView', title: 'Controller view', settings: [
      { id: 'controllerGlass', label: 'See-through controller terminal', words: 'transparent transparency see-through glass ghost blur opacity background text strength shadow outline bold tint contrast slider presets' },
      { id: 'windowSee', label: 'Window see-through while the controller view is open', words: 'transparent translucent window desktop opacity see-through app' },
      { id: 'taskThinBar', label: 'Fold the header of normal tasks to a thin bar too', words: 'collapse collapsed header compact bar' },
    ] },
    { id: 'updates', title: 'Updates', settings: [
      { id: 'autoReload', label: 'Reload automatically when Taskboard is updated', words: 'release reload' },
    ] },
    { id: 'performance', title: 'Performance', settings: [
      { id: 'termWebgl', label: 'Draw terminals with WebGL', words: 'gpu webgl renderer terminal slow cpu draw fast' },
      { id: 'perfMonitor', label: 'Show the performance monitor', words: 'slow freeze lag cpu memory swap load event loop long task monitor' },
    ] },
  ] },
  { id: 'keys', title: 'Keyboard shortcuts', help: 'The keys for each action. These keys are saved in this app or browser only.', groups: [
    { id: 'keys', settings: [
      { id: 'keyboardShortcuts', label: 'Keyboard shortcuts', words: 'key keys hotkey shortcut' },
    ] },
  ] },
];

const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

// A test for one query: true when every word of the query is in the text. Null for an empty query.
export function matcher(query: string): ((text: string) => boolean) | null {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  return text => { const t = fold(text); return words.every(w => t.includes(w)); };
}

// The text that the search compares with the query: the section title, the group title, the label and the extra words.
export function settingText(id: string): string {
  for (const s of SECTIONS) for (const g of s.groups) for (const d of g.settings) if (d.id === id) return [s.title, g.title, d.label, d.words].filter(Boolean).join(' ');
  return '';
}

export interface SettingsFilter {
  query: string;
  shows(id: string): boolean;
  groupShows(sectionId: string, groupId: string): boolean;
  count(sectionId: string): number;
  total: number;
}

// Which settings the page shows for a query. `extra` adds search text that only the page knows, for example the
// names of the keyboard actions. An empty query shows every setting.
export function filterSettings(query: string, extra: Record<string, string> = {}): SettingsFilter {
  const test = matcher(query);
  const shown = new Set<string>();
  for (const s of SECTIONS) for (const g of s.groups) for (const d of g.settings) {
    if (!test || test(settingText(d.id)) || (extra[d.id] && test(extra[d.id]))) shown.add(d.id);
  }
  const section = (id: string) => SECTIONS.find(s => s.id === id);
  const groupShows = (sectionId: string, groupId: string) => !!section(sectionId)?.groups.find(g => g.id === groupId)?.settings.some(d => shown.has(d.id));
  const count = (sectionId: string) => section(sectionId)?.groups.reduce((n, g) => n + g.settings.filter(d => shown.has(d.id)).length, 0) || 0;
  return { query, shows: id => shown.has(id), groupShows, count, total: shown.size };
}
