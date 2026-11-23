// The guard reads each command as JSON text. These tests never execute the commands they pass to it.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const guard = fileURLToPath(new URL('../server/hooks/guard.mjs', import.meta.url));
// Task 802 wrote this Python script with a heredoc and ran it. The script starts Claude, stops it with p.kill(), and
// runs server/trust.ts with node --import tsx. The guard denied it as a command that stops the real server.
const nativeProbe = readFileSync(fileURLToPath(new URL('./fixtures/guard-native-claude-probe.sh.txt', import.meta.url)), 'utf8');

// a scratch TASKBOARD_DIR whose server.pid names process 48213; run(command) gives the deny reason or ''
function stopGuard() {
  const dir = mkdtempSync(join(tmpdir(), 'tb-stop-guard-'));
  writeFileSync(join(dir, 'server.pid'), JSON.stringify({ pid: 48213 }));
  const run = command => {
    const result = spawnSync(process.execPath, [guard], {
      input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8',
      env: { ...process.env, TASKBOARD_DIR: dir, TASK_ID: 'task-802', TASKBOARD_TMUX_SOCKET: 'tb-stop-test', TASKBOARD_PORT: '4317' },
    });
    assert.equal(result.status, 0);
    return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason : '';
  };
  return { run, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a script that starts node --import tsx and stops only its own child with p.kill() may run', () => {
  const g = stopGuard();
  try {
    assert.equal(g.run(nativeProbe), '');
    assert.equal(g.run(`python3 -c "import subprocess; p=subprocess.Popen(['node','--import','tsx','a.ts']); p.kill()"`), '');
    assert.equal(g.run(`node --import=tsx -e "const c=require('child_process').spawn('sleep',['9']); c.kill()"`), '');
  } finally { g.done(); }
});

test('commands that stop the real server stay denied, also next to child cleanup', () => {
  const g = stopGuard();
  try {
    const denied = [
      'pkill -f "tsx server/index.ts"',
      'killall node',
      'kill 48213',
      'kill $(cat ~/.taskboard/server.pid)',
      'pgrep -f server/index | xargs kill',
      // the real server's command line contains --import tsx
      "pgrep -f -- '--import tsx' | xargs kill",
      'kill $(pgrep -f tsx)',
      'lsof -ti tcp:4317 | xargs kill',
      'tmux -L tb-stop-test kill-server',
      `python3 -c "import psutil; [p.kill() for p in psutil.process_iter() if 'tsx' in ' '.join(p.cmdline())]"`,
      `python3 -c "import subprocess,psutil; o=subprocess.run(['pgrep','-f','--import','tsx'],capture_output=True,text=True).stdout; [psutil.Process(int(x)).kill() for x in o.split()]"`,
      `python3 -c "import os,subprocess; p=subprocess.Popen(['node','--import','tsx','a.ts']); p.kill(); os.kill(int(open(os.path.expanduser('~/.taskboard/server.pid')).read()),9)"`,
      `node --import tsx -e "process.kill(Number(process.argv[1]))" 48213`,
      nativeProbe + 'pkill -f tsx\n',
      nativeProbe.replace('p.kill()', 'os.kill(p.pid, 9)') + 'kill $(pgrep -f tsx)\n',
    ];
    for (const command of denied) assert.match(g.run(command), /Blocked by Taskboard/, command);
  } finally { g.done(); }
});
