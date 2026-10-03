// Tests for server/processes.ts (GET /api/processes, tb top) with a fake process table, and for the agent process
// name of server/agents.ts (namedCommand).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { etimeSec, groupProcesses, parsePs, parseTaskEnv, parseTopPower, TASKBOARD, type PsRow, type ProcInput } from '../server/processes.ts';

const B = '/Users/me/.taskboard/browsers';
const row = (pid: number, ppid: number, name: string, args = name, cpu = 1, rssKb = 1024, etime = '01:00'): PsRow => ({ pid, ppid, uid: 501, cpu, rssKb, etime, name, args });
const tasks = [
  { id: 'fix-login-12', num: 12, title: 'Fix login', session: 'task-12' },
  { id: 'add-search-13', num: 13, title: 'Add search', session: 'task-13' },
  { id: 'controller', num: 0, title: 'Controller', session: 'tb-controller' },
];
// launchd(1) → Taskboard Server launcher 100 (older installs: tsx) → server 101 → task browser Chrome 300 → helpers
// tmux server 200 (adopted by launchd, TASK_ID=controller in its environment) → panes 210 (task 12), 220 (proc-12),
// 230 (task 13), 240 (controller); agent 210 → shell 211 → test server 212; agent 230 → MCP server 231
const rows: PsRow[] = [
  row(1, 0, 'launchd'),
  row(100, 1, 'Taskboard Server', '/Users/me/.taskboard/Taskboard Server.app/Contents/MacOS/Taskboard Server --import tsx server/index.ts', 0.5),
  row(101, 100, 'Taskboard Server', 'Taskboard Server --import tsx server/index.ts', 3, 300 * 1024),
  row(300, 101, 'Google Chrome', `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --user-data-dir=${B}/fix-login-12/profile`, 10, 200 * 1024),
  row(301, 300, 'Google Chrome He', '/Applications/Google Chrome.app/.../Google Chrome Helper (Renderer) --type=renderer', 20, 100 * 1024),
  row(310, 101, 'Google Chrome', `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${B}/template/profile`),
  row(320, 101, 'tmux', 'tmux -L taskboard attach-session -t =task-13'),
  row(200, 1, 'tmux', 'tmux -L taskboard new-session -d -s tb-controller'),
  row(205, 200, 'sh', "sh -c cat >> '/Users/me/AgentVault/tasks/add-search-13/terminal.log'"),
  row(210, 200, '2.1.288', 'tb#12 claude --settings x', 30, 500 * 1024),
  row(211, 210, 'zsh', '/bin/zsh -c pnpm sandbox'),
  row(212, 211, 'node', 'node /x/node_modules/.bin/tsx server/index.ts', 5),
  row(220, 200, 'sh', '/bin/sh /tmp/run-dev.sh'),
  row(221, 220, 'node', 'node vite'),
  row(230, 200, 'codex', 'tb#13 codex -a on-request', 7),
  row(231, 230, 'node', 'node /opt/homebrew/bin/chrome-devtools-mcp'),
  row(240, 200, '2.1.288', 'tb#controller claude'),
  row(400, 1, 'node', 'node /x/server/index.ts', 2),          // a sandbox server that left the tree; TASK_ID=fix-login-12
  row(401, 400, 'tmux', 'tmux -L sandbox-x new-session'),
  row(500, 1, 'Slack', '/Applications/Slack.app/Contents/MacOS/Slack'), // not Taskboard
];
const input = (extra: Partial<ProcInput> = {}): ProcInput => ({
  rows, serverPid: 101, tmuxServerPid: 200, browsersDir: B, tasks,
  panes: [{ session: 'task-12', panePid: 210 }, { session: 'proc-12', panePid: 220 }, { session: 'task-13', panePid: 230 }, { session: 'tb-controller', panePid: 240 }],
  taskEnv: new Map([[400, 'fix-login-12'], [200, 'controller']]), ...extra,
});
const pidsOf = (t: ReturnType<typeof groupProcesses>, key: string) => t.groups.find(g => g.key === key)?.procs.map(p => p.pid).sort((a, b) => a - b);

test('every process goes to the task that owns it, and the rest of Taskboard to Taskboard', () => {
  const t = groupProcesses(input());
  assert.deepEqual(pidsOf(t, 'fix-login-12'), [210, 211, 212, 220, 221, 300, 301, 400, 401]);
  assert.deepEqual(pidsOf(t, 'add-search-13'), [205, 230, 231, 320]);
  assert.deepEqual(pidsOf(t, 'controller'), [240]);
  assert.deepEqual(pidsOf(t, TASKBOARD), [100, 101, 200, 310]);
  assert.equal(t.groups.flatMap(g => g.procs).some(p => p.pid === 500 || p.pid === 1), false);
  assert.equal(t.groups[0].key, TASKBOARD, 'Taskboard first, then the tasks by CPU');
  assert.equal(t.groups[1].key, 'fix-login-12');
  assert.equal(t.groups.find(g => g.key === 'controller')!.label, 'Controller');
});

test('the kinds of processes', () => {
  const t = groupProcesses(input());
  const kind = (pid: number) => t.groups.flatMap(g => g.procs).find(p => p.pid === pid)!.kind;
  assert.equal(kind(101), 'server'); assert.equal(kind(100), 'launcher'); assert.equal(kind(200), 'tmux');
  assert.equal(kind(210), 'agent'); assert.equal(kind(230), 'agent'); assert.equal(kind(220), 'tb run');
  assert.equal(kind(300), 'browser'); assert.equal(kind(301), 'browser'); assert.equal(kind(231), 'mcp server');
  assert.equal(kind(212), 'test server'); assert.equal(kind(211), 'shell');
});

test('totals per task and for Taskboard; energy only when it was measured', () => {
  let t = groupProcesses(input());
  const g = t.groups.find(x => x.key === 'fix-login-12')!;
  assert.equal(g.totals.count, 9);
  assert.equal(g.totals.cpu, 30 + 1 + 5 + 1 + 1 + 10 + 20 + 2 + 1);
  assert.equal(g.totals.power, null);
  assert.equal(t.totals.count, t.groups.reduce((n, x) => n + x.totals.count, 0));
  t = groupProcesses(input({ power: new Map([[210, 12.5], [301, 40]]) }));
  assert.equal(t.groups.find(x => x.key === 'fix-login-12')!.totals.power, 52.5);
  assert.equal(t.totals.power, 52.5);
});

test('ps, top and environment output are parsed', () => {
  const stats = '  101   100   501   3.0 307200 01-02:03:04 Taskboard Server\n  301   300   501  20.5 102400    05:06 Google Chrome He\n';
  const args = '  101 Taskboard Server --import tsx server/index.ts\n';
  const r = parsePs(stats, args);
  assert.deepEqual(r[0], { pid: 101, ppid: 100, uid: 501, cpu: 3, rssKb: 307200, etime: '01-02:03:04', name: 'Taskboard Server', args: 'Taskboard Server --import tsx server/index.ts' });
  assert.equal(r[1].name, 'Google Chrome He'); assert.equal(r[1].args, 'Google Chrome He');
  assert.equal(etimeSec('01-02:03:04'), 93784); assert.equal(etimeSec('05:06'), 306);
  const top = 'Processes: 2\nPID    POWER\n101    0.0 \nPID    POWER\n101    3.4 \n301    40.1 \n';
  assert.deepEqual([...parseTopPower(top)], [[101, 3.4], [301, 40.1]]);
  assert.deepEqual([...parseTaskEnv('  400 node x TERM=xterm TASK_ID=fix-login-12 TASK_NUM=12\n  401 node y HOME=/x\n')], [[400, 'fix-login-12']]);
});

test('agents start with the task number in argv[0]', async () => {
  const { namedCommand } = await import('../server/agents.ts');
  assert.deepEqual(namedCommand({ num: 12, role: undefined } as never, ['claude', '--settings', 'x'], 'darwin'),
    ['/bin/sh', '-c', 'exec -a "$0" "$@"', 'tb#12 claude', 'claude', '--settings', 'x']);
  assert.deepEqual(namedCommand({ num: 0, role: 'controller' } as never, ['/Users/me/.local/bin/agy'], 'linux', true).slice(0, 4), ['/bin/bash', '-c', 'exec -a "$0" "$@"', 'tb#controller agy']);
  assert.deepEqual(namedCommand({ num: 3 } as never, ['codex'], 'linux', false), ['codex']);
});
