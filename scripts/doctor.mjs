// pnpm doctor: why the Taskboard server does not answer, and the step that repairs it (desktop/doctor.cjs).
//   pnpm doctor            prints the state, the reason and the last log lines; changes nothing. Tasks may run it.
//   pnpm doctor --repair   runs the repair that the state offers (install the login service, or restart it).
//                          Only the user runs it: it refuses inside a Taskboard task for the real service.
//   pnpm doctor --json     the facts and the state as JSON.
// The Taskboard app shows the same check on its waiting page, with a Start server button.
import { createRequire } from 'node:module';

const doctor = createRequire(import.meta.url)('../desktop/doctor.cjs');
const args = process.argv.slice(2);
const cfg = doctor.config();

if (args.includes('--repair')) {
  if (process.env.TASK_ID && cfg.label === doctor.REAL_LABEL) {
    console.log('Not repaired: this runs inside a Taskboard task. Only the user repairs the real login service, from the Taskboard app (Start server) or Terminal.');
    process.exit(1);
  }
  const r = await doctor.repair(cfg);
  for (const l of r.output || []) if (l !== r.line) console.log(`  ${l}`);
  console.log(r.line);
  if (r.after) console.log(`Now: ${r.after.title}.`);
  process.exit(r.ok ? 0 : 1);
}

const c = await doctor.check(cfg);
if (args.includes('--json')) { console.log(JSON.stringify(c, null, 2)); process.exit(c.ok ? 0 : 1); }
const f = c.facts;
console.log(`${c.ok ? 'OK' : 'Problem'}: ${c.title}.`);
console.log(c.reason);
if (c.next) console.log(`Next step: ${c.next}`);
else if (c.action === 'install') console.log("Repair: click Start server in the Taskboard app, or run 'pnpm doctor --repair' (it runs scripts/install-launchd.sh of the release).");
else if (c.action === 'restart') console.log("Repair: click Start server in the Taskboard app, or run 'pnpm doctor --repair' (it restarts the login service).");
if (f.platform === 'darwin') {
  console.log('');
  console.log(`Login service ${f.label}: file ${f.plistExists ? 'present' : 'missing'}${f.disabled ? ', turned off' : ''}, ${f.loaded ? `loaded, state ${f.service?.state}${f.service?.pid ? `, process ${f.service.pid}` : ''}${f.service?.lastExit ? `, last exit code ${f.service.lastExit}` : ''}` : 'not loaded'}.`);
  console.log(`Program: ${f.program || 'unknown'}. Release: ${f.release || 'none'}.`);
  if (f.lastInstall) console.log(`Last install ${f.lastInstall.at}: ${f.lastInstall.line}`);
}
if (c.logTail?.length) { console.log(`\nLast lines of ${f.log}:`); for (const l of c.logTail) console.log(`  ${l}`); }
process.exit(c.ok ? 0 : 1);
