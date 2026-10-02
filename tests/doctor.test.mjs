// Tests for desktop/doctor.cjs (pnpm doctor and the Mac app's waiting page): fake launchctl, lsof and ps programs first
// on PATH, a fake server.log, a test label and a TASKBOARD_DIR in the system temp folder. A small HTTP server stands in
// for a Taskboard server that answers. The real launchctl is never called.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const doctor = createRequire(import.meta.url)('../desktop/doctor.cjs');
const root = mkdtempSync(join(tmpdir(), 'tb-doctor-'));
after(() => rmSync(root, { recursive: true, force: true }));
const LABEL = 'local.tbtest.doctor';
const PLIST = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array><string>/x/Taskboard Server</string></array></dict></plist>`;

// The fake launchctl prints <fake>/print (exit 0) when it exists, else fails like an unknown service; print-disabled
// prints <fake>/disabled. lsof prints <fake>/lsof. ps prints <fake>/etime. kickstart is recorded in <fake>/calls.
const LAUNCHCTL = `#!/bin/sh
echo "$*" >> "$FAKE/calls"
case "$1" in
  print) [ -f "$FAKE/print" ] && { cat "$FAKE/print"; exit 0; }; echo "Could not find service \\"$2\\"" >&2; exit 113 ;;
  print-disabled) cat "$FAKE/disabled" 2>/dev/null; exit 0 ;;
  kickstart) exit 0 ;;
esac
`;
let n = 0;
async function setup({ release = true, plist = true, print, disabled, lsof, etime, log, answerPid } = {}) {
  const dir = join(root, String(++n));
  const fake = join(dir, 'fake'), bin = join(dir, 'bin'), tb = join(dir, 'tb'), agents = join(dir, 'agents');
  for (const d of [fake, bin, tb, agents]) mkdirSync(d, { recursive: true });
  if (release) { mkdirSync(join(tb, 'app', 'server'), { recursive: true }); writeFileSync(join(tb, 'app', 'server', 'index.ts'), ''); }
  if (plist) writeFileSync(join(agents, `${LABEL}.plist`), plist === 'bad' ? '<plist><dict>' : PLIST);
  if (print) writeFileSync(join(fake, 'print'), print);
  if (disabled) writeFileSync(join(fake, 'disabled'), disabled);
  if (lsof) writeFileSync(join(fake, 'lsof'), lsof);
  writeFileSync(join(fake, 'etime'), etime || '');
  if (log) writeFileSync(join(tb, 'server.log'), log);
  for (const [name, body] of [['launchctl', LAUNCHCTL], ['lsof', '#!/bin/sh\ncat "$FAKE/lsof" 2>/dev/null; exit 0\n'], ['ps', '#!/bin/sh\ncat "$FAKE/etime"\n']]) {
    writeFileSync(join(bin, name), body); chmodSync(join(bin, name), 0o755);
  }
  // a port that answers /api/info with answerPid, or a port where nothing listens
  const srv = createServer((_q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ pid: answerPid })); });
  await new Promise(res => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  if (!answerPid) await new Promise(res => srv.close(res));
  else after(() => srv.close());
  const cfg = doctor.config({ ...process.env, HOME: dir, FAKE: fake, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, TB_LAUNCHD_LABEL: LABEL, TB_LAUNCHD_DIR: agents, TASKBOARD_DIR: tb, TASKBOARD_PORT: String(port) });
  return { cfg, fake, port };
}
const running = pid => `gui/501/${LABEL} = {\n\tstate = running\n\tpid = ${pid}\n\tlast exit code = (never exited)\n\truns = 1\n}`;

test('the parsers read launchctl print, print-disabled and ps etime', () => {
  assert.deepEqual(doctor.parsePrint('\tstate = not running\n\truns = 12\n\tlast exit code = 1\n'), { state: 'not running', pid: null, lastExit: '1', runs: 12 });
  assert.equal(doctor.parseDisabled(`disabled services = {\n\t"${LABEL}" => disabled\n}`, LABEL), true);
  assert.equal(doctor.parseDisabled(`\t"${LABEL}" => enabled`, LABEL), false);
  assert.equal(doctor.parseDisabled(`\t"${LABEL}.x" => disabled`, LABEL), false);
  assert.equal(doctor.etimeSec('01-02:03:04'), 93784);
  assert.equal(doctor.etimeSec('  00:42'), 42);
});

test('running: the server answers and the login service runs it', async () => {
  const { cfg } = await setup({ print: running(4242), answerPid: 4242 });
  const c = await doctor.check(cfg);
  assert.equal(c.state, 'running'); assert.equal(c.ok, true); assert.equal(c.action, null);
});

test('running by hand: the server answers, but not from the service', async () => {
  const { cfg } = await setup({ print: undefined, answerPid: 777 });
  const c = await doctor.check(cfg);
  assert.equal(c.state, 'running-by-hand'); assert.equal(c.action, 'install');
  assert.match(c.reason, /will not start by itself after a restart/);
});

test('release missing, plist missing, plist damaged, disabled and not loaded', async () => {
  assert.equal((await doctor.check((await setup({ release: false })).cfg)).state, 'release-missing');
  const missing = await doctor.check((await setup({ plist: false })).cfg);
  assert.equal(missing.state, 'plist-missing'); assert.equal(missing.action, 'install');
  assert.equal((await doctor.check((await setup({ plist: 'bad' })).cfg)).state, 'plist-invalid');
  const off = await doctor.check((await setup({ disabled: `\t"${LABEL}" => disabled\n` })).cfg);
  assert.equal(off.state, 'disabled'); assert.equal(off.action, 'install');
  const notLoaded = await doctor.check((await setup({})).cfg);
  assert.equal(notLoaded.state, 'not-loaded'); assert.equal(notLoaded.action, 'install');
  assert.match(notLoaded.reason, /stopped halfway/);
});

test('crashed: loaded, not running, with the last exit code and the last log lines', async () => {
  const log = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\nError: Cannot find module tsx\n';
  const { cfg } = await setup({ print: '\tstate = not running\n\tlast exit code = 1\n\truns = 9\n', log });
  const c = await doctor.check(cfg);
  assert.equal(c.state, 'crashed'); assert.equal(c.action, 'restart');
  assert.match(c.reason, /last exit code was 1/);
  assert.equal(c.logTail.length, 12);
  assert.equal(c.logTail[c.logTail.length - 1], 'Error: Cannot find module tsx');
});

test('starting, not answering, and port busy', async () => {
  const starting = await doctor.check((await setup({ print: running(4242), etime: '00:12' })).cfg);
  assert.equal(starting.state, 'starting'); assert.equal(starting.action, 'wait');
  const stuck = await doctor.check((await setup({ print: running(4242), etime: '05:00' })).cfg);
  assert.equal(stuck.state, 'not-answering'); assert.equal(stuck.action, 'restart');
  const busy = await doctor.check((await setup({ print: '\tstate = spawn scheduled\n\tlast exit code = 1\n', lsof: 'p999\ncPython\n' })).cfg);
  assert.equal(busy.state, 'port-busy'); assert.equal(busy.action, null);
  assert.match(busy.next, /Quit Python \(process 999\)/);
});

test('repair runs the action of a fresh check: restart is a kickstart of the service', async () => {
  const { cfg, fake } = await setup({ print: '\tstate = not running\n\tlast exit code = 1\n' });
  const r = await doctor.repair({ ...cfg, upWaitMs: 1500 });
  const calls = (await import('node:fs')).readFileSync(join(fake, 'calls'), 'utf8');
  assert.match(calls, new RegExp(`^kickstart -k gui/\\d+/${LABEL.replace(/\./g, '\\.')}$`, 'm'));
  assert.equal(r.ok, false, 'the fake service never answers');
}, { timeout: 60_000 });

test('repair with nothing to repair runs no command', async () => {
  const { cfg, fake } = await setup({ release: false });
  const r = await doctor.repair(cfg);
  assert.equal(r.ok, false);
  assert.match(r.line, /pnpm release/);
  assert.doesNotMatch((await import('node:fs')).readFileSync(join(fake, 'calls'), 'utf8'), /kickstart|bootstrap|bootout/);
});
