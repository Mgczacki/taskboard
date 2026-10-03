// Tests for scripts/install-launchd.sh with fake launchctl, curl, lsof and id programs first on PATH. The fake launchctl
// records each call and keeps the service state in files: a test label and a TASKBOARD_DIR in the system temp folder.
// Nothing here calls the real launchctl, and nothing touches ~/.taskboard or ~/Library/LaunchAgents.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const script = fileURLToPath(new URL('../scripts/install-launchd.sh', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'tb-install-'));
after(() => rmSync(root, { recursive: true, force: true }));
const LABEL = 'local.tbtest.install';

// State files in <fake>/: loaded (the service is loaded), fail-left (bootstraps that fail before one works),
// gone-after (prints that still find the service after a bootout: launchd removes it asynchronously),
// probe-fail, gui-fail, never-up, calls (one line per call).
const LAUNCHCTL = `#!/bin/sh
F="$FAKE"; echo "$*" >> "$F/calls"
case "$1" in
  print)
    case "$2" in
      */*/*) if [ -f "$F/gone-after" ]; then n=$(cat "$F/gone-after"); if [ "$n" -gt 0 ]; then echo $((n-1)) > "$F/gone-after"; echo "state = running"; exit 0; fi; rm -f "$F/gone-after" "$F/loaded"; fi
             [ -f "$F/loaded" ] && { echo "state = running"; echo "pid = 4242"; exit 0; }; echo "Could not find service" >&2; exit 113 ;;
      *) [ -f "$F/gui-fail" ] && { echo "Bad request." >&2; exit 5; }; echo "domain = gui"; exit 0 ;;
    esac ;;
  bootstrap)
    case "$3" in *.probe.*) [ -f "$F/probe-fail" ] && { echo "Bootstrap failed: 1: Operation not permitted" >&2; exit 1; }; exit 0 ;; esac
    n=$(cat "$F/fail-left" 2>/dev/null || echo 0)
    if [ "$n" -gt 0 ]; then echo $((n-1)) > "$F/fail-left"; echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi
    cp "$3" "$F/loaded-plist"; touch "$F/loaded"; exit 0 ;;
  bootout) case "$2" in *.probe.*) exit 0 ;; esac
    [ -f "$F/loaded" ] || exit 3; [ -f "$F/async" ] && { echo 3 > "$F/gone-after"; exit 0; }; rm -f "$F/loaded"; exit 0 ;;
  enable) exit 0 ;;
esac
exit 0
`;
// curl answers 200 while the service is loaded, unless never-up exists
const CURL = `#!/bin/sh
[ -f "$FAKE/loaded" ] && [ ! -f "$FAKE/never-up" ] && { printf 200; exit 0; }; printf 000; exit 7
`;

function setup(name) {
  const dir = join(root, name);
  const fake = join(dir, 'fake'), bin = join(dir, 'bin'), tb = join(dir, 'tbdir'), agents = join(dir, 'agents');
  for (const d of [fake, bin, join(tb, 'app', 'server'), join(tb, 'app', 'node_modules', 'tsx'), agents]) mkdirSync(d, { recursive: true });
  writeFileSync(join(tb, 'app', 'server', 'index.ts'), '');
  writeFileSync(join(tb, 'app', 'node_modules', 'tsx', 'package.json'), '{}');
  for (const [n, body] of [['launchctl', LAUNCHCTL], ['curl', CURL], ['lsof', '#!/bin/sh\nexit 1\n']]) { writeFileSync(join(bin, n), body); chmodSync(join(bin, n), 0o755); }
  const env = { ...process.env, FAKE: fake, PATH: `${bin}:${process.env.PATH}`, TB_LAUNCHD_LABEL: LABEL, TB_LAUNCHD_DIR: agents, TASKBOARD_DIR: tb,
    TASKBOARD_PORT: '4391', TB_INSTALL_WAIT_GONE: '2', TB_INSTALL_WAIT_UP: '2', TB_INSTALL_TRIES: '3' };
  delete env.TASK_ID;
  const run = (args = [], extra = {}) => {
    const r = spawnSync('/bin/sh', [script, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 60_000 });
    const lines = r.stdout.trim().split('\n');
    return { code: r.status, out: r.stdout + r.stderr, last: lines[lines.length - 1] };
  };
  const calls = () => existsSync(join(fake, 'calls')) ? readFileSync(join(fake, 'calls'), 'utf8').trim().split('\n') : [];
  const main = () => calls().filter(c => c.includes(LABEL) && !c.includes('.probe.'));
  return { dir, fake, bin, tb, plist: join(agents, `${LABEL}.plist`), run, calls, main, set: (f, v = '') => writeFileSync(join(fake, f), String(v)) };
}

test('a first install retries bootstrap after "5: Input/output error" and checks that the server answers', () => {
  const s = setup('first');
  s.set('fail-left', 2);
  const r = s.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.last, /^Installed and running:/);
  const boots = s.main().filter(c => c.startsWith('bootstrap'));
  assert.equal(boots.length, 3, 'two failed tries, then one that worked');
  // enable comes before bootstrap: a disabled label does not load
  assert.ok(s.main().indexOf(s.main().find(c => c.startsWith('enable'))) < s.main().indexOf(boots[0]));
  const plist = readFileSync(s.plist, 'utf8');
  assert.match(plist, /<key>AssociatedBundleIdentifiers<\/key><array><string>com\.taskboard\.desktop<\/string>/);
  assert.match(plist, /Taskboard Server\.app\/Contents\/MacOS\/Taskboard Server<\/string><string>--import<\/string><string>tsx<\/string><string>server\/index\.ts/);
  assert.match(plist, /<key>TASKBOARD_DIR<\/key>/);
  assert.equal(spawnSync('plutil', ['-lint', s.plist]).status, 0);
  assert.ok(existsSync(join(s.tb, 'Taskboard Server.app', 'Contents', 'MacOS', 'Taskboard Server')));
  assert.equal(JSON.parse(readFileSync(join(s.tb, 'launchd-install.json'), 'utf8')).ok, true);
  // the probe ran in a temporary folder, not next to the real plist
  assert.ok(s.calls().some(c => /^bootstrap gui\/\d+ .*tb-install\.[^/]+\/local\.tbtest\.install\.probe\.\d+\.plist$/.test(c)));
});

test('a second run changes nothing and does not restart the server', () => {
  const s = setup('twice');
  assert.equal(s.run().code, 0);
  const before = s.main().length;
  const r = s.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.last, /no change was needed/);
  assert.deepEqual(s.main().slice(before).filter(c => /^(bootout|bootstrap)/.test(c)), []);
});

test('--force waits until launchctl print no longer finds the old service before it loads the new one', () => {
  const s = setup('force');
  assert.equal(s.run().code, 0);
  s.set('async');
  const before = s.main().length;
  const r = s.run(['--force']);
  assert.equal(r.code, 0, r.out);
  const after = s.main().slice(before);
  const out = after.findIndex(c => c.startsWith('bootout')), boot = after.findIndex(c => c.startsWith('bootstrap'));
  assert.ok(out >= 0 && boot > out);
  const printsBetween = after.slice(out + 1, boot).filter(c => c.startsWith('print'));
  assert.ok(printsBetween.length >= 4, `polled ${printsBetween.length} times`);
  assert.equal(s.main().filter(c => c.startsWith('bootstrap')).length, 2, 'no failed bootstrap: it waited');
});

test('a failure after the removal puts the previous plist back and loads it again', () => {
  const s = setup('restore');
  assert.equal(s.run().code, 0);
  const old = readFileSync(s.plist, 'utf8').replace('<key>RunAtLoad</key>', '<key>Comment</key><string>previous</string><key>RunAtLoad</key>');
  writeFileSync(s.plist, old);
  s.set('fail-left', 4); // three tries of the new plist fail, the first try of the restore fails, the second works
  const r = s.run(['--force']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.last, /^Not installed: launchctl bootstrap failed 3 times: Bootstrap failed: 5: Input\/output error/);
  assert.match(r.out, /The previous service was put back and loaded again\./);
  assert.equal(readFileSync(s.plist, 'utf8'), old);
  assert.ok(existsSync(join(s.fake, 'loaded')), 'the service is loaded, not left removed');
  assert.equal(readFileSync(join(s.fake, 'loaded-plist'), 'utf8'), old);
  assert.equal(JSON.parse(readFileSync(join(s.tb, 'launchd-install.json'), 'utf8')).ok, false);
});

test('a server that does not answer within the wait is reported with the log, and the previous service comes back', () => {
  const s = setup('noanswer');
  assert.equal(s.run().code, 0);
  writeFileSync(join(s.tb, 'server.log'), 'line one\nError: Cannot find module x\n');
  s.set('never-up');
  const r = s.run(['--force']);
  assert.equal(r.code, 1);
  assert.match(r.out, /Error: Cannot find module x/);
  assert.match(r.out, /The previous service was put back/);
  assert.match(r.last, /^Not installed: the new service loaded, but the server did not answer within 2 s\./);
});

test('it refuses, and changes nothing, where launchctl cannot load services or as root', () => {
  const probe = setup('probe');
  probe.set('probe-fail');
  let r = probe.run();
  assert.equal(r.code, 1);
  assert.match(r.last, /^Not installed: launchctl may not load services from this shell \(Bootstrap failed: 1: Operation not permitted\)\. Nothing was changed\./);
  assert.equal(existsSync(probe.plist), false);
  assert.deepEqual(probe.main(), []);

  const gui = setup('gui');
  gui.set('gui-fail');
  r = gui.run();
  assert.equal(r.code, 1);
  assert.match(r.last, /cannot reach your login session/);
  assert.equal(gui.calls().filter(c => c.startsWith('bootstrap')).length, 0);

  const root0 = setup('root');
  writeFileSync(join(root0.bin, 'id'), '#!/bin/sh\necho 0\n'); chmodSync(join(root0.bin, 'id'), 0o755);
  r = root0.run();
  assert.equal(r.code, 1);
  assert.match(r.last, /runs as root \(sudo\)/);
  assert.deepEqual(root0.calls(), []);
});

test('the real label is refused inside a task and for a test folder; a test label needs a test folder', () => {
  const s = setup('labels');
  let r = s.run([], { TASK_ID: 'some-task-1', TB_LAUNCHD_LABEL: 'com.taskboard.server', TASKBOARD_DIR: '' });
  assert.equal(r.code, 1); assert.match(r.last, /inside a Taskboard task/);
  r = s.run([], { TB_LAUNCHD_LABEL: 'com.taskboard.server' });
  assert.equal(r.code, 1); assert.match(r.last, /TASKBOARD_DIR is set, so this is a test install, but the label is the real/);
  r = s.run([], { TASKBOARD_DIR: '' });
  assert.equal(r.code, 1); assert.match(r.last, /needs its own TASKBOARD_DIR/);
  assert.deepEqual(s.calls(), []);
});

test('the guard refuses the doctor repair for agents and allows the read-only check', () => {
  const guard = fileURLToPath(new URL('../server/hooks/guard.mjs', import.meta.url));
  const g = command => spawnSync(process.execPath, [guard], { input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8', env: { ...process.env, TASKBOARD_DIR: join(root, 'guard'), TASK_ID: 'task-1' } }).stdout;
  assert.match(g('pnpm doctor --repair'), /permissionDecision.*deny/);
  assert.match(g('node scripts/doctor.mjs --repair'), /permissionDecision.*deny/);
  assert.equal(g('pnpm doctor'), '');
  assert.equal(g('pnpm doctor --json'), '');
});
