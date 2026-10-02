#!/usr/bin/env node
// Switch the real Taskboard to another release.
//   pnpm rollback          the release before the current one
//   pnpm rollback <id>     a specific release (see: pnpm rollback --list)
import { join } from 'node:path';
import { RELEASES, currentRelease, log, releases, restartProduction, switchTo } from './lib.mjs';

const all = releases(), cur = currentRelease(), arg = process.argv[2];
if (arg === '--list' || !all.length) {
  if (!all.length) log('No releases yet. Make one with: pnpm release');
  for (const r of all) log(`${r.id === cur ? '→' : ' '} ${r.id}  ${r.meta.ref}  ${r.meta.created}`);
  process.exit(0);
}
const i = all.findIndex(r => r.id === cur);
const target = arg ? all.find(r => r.id === arg) : all[i - 1];
if (!target) { log(arg ? `No release ${arg}.` : 'There is no release before the current one.'); process.exit(1); }
switchTo(join(RELEASES, target.id));
log(`~/.taskboard/app → ${target.id}. Restarting…`);
const info = await restartProduction('rollback', `rollback to ${target.id}`);
log(info ? `Taskboard is running ${target.id} (process ${info.pid}).` : 'The server did not answer; check ~/.taskboard/server.log.');
