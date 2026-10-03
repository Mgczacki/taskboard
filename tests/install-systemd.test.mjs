// Tests for scripts/install-systemd.sh with a fake systemctl and curl first on PATH, a test unit name and a
// TASKBOARD_DIR in the system temp folder. They check the script's steps; they do not run systemd.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const script = fileURLToPath(new URL('../scripts/install-systemd.sh', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'tb-systemd-'));
after(() => rmSync(root, { recursive: true, force: true }));
const UNIT = 'tbtest-systemd';
// <fake>/active: the service runs; <fake>/fail-left: starts that fail first; <fake>/calls: one line per call
const SYSTEMCTL = `#!/bin/sh
F="$FAKE"; shift; echo "$*" >> "$F/calls"
case "$1" in
  show-environment|daemon-reload) exit 0 ;;
  is-active) [ -f "$F/active" ] && exit 0; exit 3 ;;
  stop) rm -f "$F/active"; exit 0 ;;
  enable) n=$(cat "$F/fail-left" 2>/dev/null || echo 0); if [ "$n" -gt 0 ]; then echo $((n-1)) > "$F/fail-left"; echo "Job failed" >&2; exit 1; fi
          cp "$TB_SYSTEMD_DIR/${UNIT}.service" "$F/started-unit"; touch "$F/active"; exit 0 ;;
esac
`.replace('${UNIT}', UNIT);
const CURL = '#!/bin/sh\n[ -f "$FAKE/active" ] && { printf 200; exit 0; }; printf 000; exit 7\n';

function setup(name) {
  const dir = join(root, name), fake = join(dir, 'fake'), bin = join(dir, 'bin'), tb = join(dir, 'tb'), units = join(dir, 'units');
  for (const d of [fake, bin, join(tb, 'app', 'server'), units]) mkdirSync(d, { recursive: true });
  writeFileSync(join(tb, 'app', 'server', 'index.ts'), '');
  for (const [n, body] of [['systemctl', SYSTEMCTL], ['curl', CURL]]) { writeFileSync(join(bin, n), body); chmodSync(join(bin, n), 0o755); }
  const env = { ...process.env, FAKE: fake, PATH: `${bin}:${process.env.PATH}`, TB_SYSTEMD_UNIT: UNIT, TB_SYSTEMD_DIR: units, TASKBOARD_DIR: tb, TASKBOARD_PORT: '4392', TB_INSTALL_WAIT_UP: '1', TB_INSTALL_TRIES: '3' };
  delete env.TASK_ID;
  const run = (args = []) => { const r = spawnSync('/bin/sh', [script, ...args], { env, encoding: 'utf8', timeout: 60_000 }); const l = r.stdout.trim().split('\n'); return { code: r.status, out: r.stdout + r.stderr, last: l[l.length - 1] }; };
  return { fake, tb, file: join(units, `${UNIT}.service`), run, set: (f, v = '') => writeFileSync(join(fake, f), String(v)) };
}

test('install retries the start, writes the unit and the launcher, and a second run changes nothing', () => {
  const s = setup('ok');
  s.set('fail-left', 2);
  let r = s.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.last, /^Installed and running:/);
  const unit = readFileSync(s.file, 'utf8');
  assert.match(unit, /^ExecStart=".*\/bin\/taskboard-server" --import tsx server\/index\.ts$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^Environment="TASKBOARD_DIR=/m);
  assert.ok(existsSync(join(s.tb, 'bin', 'taskboard-server')));
  r = s.run();
  assert.equal(r.code, 0); assert.match(r.last, /no change was needed/);
});

test('a failed start after the stop puts the previous unit back and starts it', () => {
  const s = setup('restore');
  assert.equal(s.run().code, 0);
  const old = readFileSync(s.file, 'utf8').replace('Description=Taskboard Server', 'Description=previous');
  writeFileSync(s.file, old);
  s.set('fail-left', 3);
  const r = s.run(['--force']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /The previous service was put back and started again\./);
  assert.equal(readFileSync(s.file, 'utf8'), old);
  assert.equal(readFileSync(join(s.fake, 'started-unit'), 'utf8'), old);
});
