#!/usr/bin/env node
// Make a release of this checkout and switch the real Taskboard to it.
//
//   pnpm release              the current files, including changes that are not committed
//   pnpm release --ref <ref>  a git commit, branch or tag
//   pnpm release --no-switch  build and test the release, but keep running the current one
//
// Steps: copy the code to ~/.taskboard/releases/<id> → install dependencies → typecheck → build the interface →
// start it once as a throwaway sandbox and check that it answers → point ~/.taskboard/app at it → restart the real
// server → if the new server does not answer within 30 s, point back at the previous release and restart again.
// Running agents are not touched: they live in tmux and reconnect to the restarted server.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { APP, RELEASES, alive, currentRelease, ensureDir, freePort, log, releases, restartProduction, startServer, staysUp, switchTo, waitForInfo, writeJson } from './lib.mjs';

const args = process.argv.slice(2);
const ref = args.includes('--ref') ? args[args.indexOf('--ref') + 1] : null;
const src = process.cwd();
const git = (...a) => execFileSync('git', a, { cwd: src, encoding: 'utf8' }).trim();
const run = (cmd, a, cwd) => execFileSync(cmd, a, { cwd, stdio: 'inherit' });

const sha = git('rev-parse', '--short', ref || 'HEAD');
const dirty = !ref && git('status', '--porcelain').length > 0;
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const id = `${stamp}-${sha}${dirty ? '-dirty' : ''}`;
const dir = join(RELEASES, id);
ensureDir(dir);
log(`Release ${id} from ${src}${ref ? ` at ${ref}` : dirty ? ' (with uncommitted changes)' : ''}`);

// 1. copy the code
if (ref) {
  execFileSync('sh', ['-c', `git archive ${ref} | tar -x -C '${dir}'`], { cwd: src, stdio: 'inherit' });
} else {
  const files = git('ls-files', '-co', '--exclude-standard').split('\n').filter(Boolean);
  for (const f of files) { if (!existsSync(join(src, f))) continue; mkdirSync(dirname(join(dir, f)), { recursive: true }); copyFileSync(join(src, f), join(dir, f)); }
}

try {
  // 2–4. install, typecheck, build
  // --force: with Node below 20.19, pnpm skips Vite's native bundler (rolldown's engines field); force installs it anyway
  run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline', '--force'], dir);
  run('pnpm', ['typecheck'], dir);
  run('pnpm', ['build'], dir);

  // 5. smoke test as a throwaway sandbox
  const t = join(tmpdir(), `taskboard-release-check-${process.pid}`);
  ensureDir(join(t, 'tbdir')); writeJson(join(t, 'tbdir', 'machine.json'), { name: 'release-check', controller: { autostart: false, remoteControl: false } });
  const port = await freePort(4450);
  const pid = startServer(dir, { TASKBOARD_DIR: join(t, 'tbdir'), TASKBOARD_VAULT: join(t, 'vault'), TASKBOARD_PORT: String(port), TASKBOARD_TMUX_SOCKET: `tbrel-${process.pid}` }, join(t, 'server.log'));
  const info = await waitForInfo(`http://127.0.0.1:${port}`, join(t, 'tbdir', 'token'), 20000).catch(() => null);
  const page = info ? (await fetch(`http://127.0.0.1:${port}/`).then(r => r.status).catch(() => 0)) : 0;
  if (alive(pid)) process.kill(pid, 'SIGTERM');
  try { execFileSync('tmux', ['-L', `tbrel-${process.pid}`, 'kill-server'], { stdio: 'ignore' }); } catch { /* none */ }
  if (!info || page !== 200) { log(`The release did not pass its start check (answer: ${info ? 'yes' : 'no'}, page: ${page}). Log: ${join(t, 'server.log')}`); throw new Error('start check failed'); }
  rmSync(t, { recursive: true, force: true });
  log('Start check passed.');

  writeJson(join(dir, 'RELEASE.json'), { id, ref: ref || 'working tree', sha, dirty, source: src, created: new Date().toISOString() });
} catch (e) {
  log(`Release ${id} failed: ${e.message}. The running Taskboard was not changed.`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

if (args.includes('--no-switch')) { log(`Built ${dir}. Switch to it later with: pnpm rollback ${id}`); process.exit(0); }

// 6–7. switch and restart; go back if the new one does not come up
const previous = currentRelease();
switchTo(dir);
log(`~/.taskboard/app → ${id}. Restarting the Taskboard server…`);
const info = await restartProduction('release', `release ${id}`);
if (info && info.root && info.root.includes(id) && (log(`Release ${id} answers (process ${info.pid}); watching it for 60 s…`), await staysUp(info.pid))) {
  log(`Taskboard is running release ${id} (process ${info.pid}).`);
} else {
  log('The new release did not answer. Switching back.');
  if (previous) { switchTo(join(RELEASES, previous)); const back = await restartProduction('rollback', `back to ${previous} after release ${id} did not answer`); log(back ? `Back on ${previous}.` : 'The previous release did not answer either; check ~/.taskboard/server.log.'); }
  process.exit(1);
}

// 8. keep the newest 5 releases (and whatever is current)
const all = releases(), keep = new Set(all.slice(-5).map(r => r.id)); keep.add(id);
for (const r of all) if (!keep.has(r.id)) { rmSync(r.dir, { recursive: true, force: true }); log(`Removed old release ${r.id}.`); }
void APP;
