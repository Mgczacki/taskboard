// Why the Taskboard server does not answer, and the one step that repairs it.
// Used by the Mac app (main.cjs: the waiting page, the menu-bar item) and by `pnpm doctor` (scripts/doctor.mjs).
//
// gather() reads the facts; it changes nothing. It runs `launchctl print` (is the service loaded, its state, pid and
// last exit code), `launchctl print-disabled`, `plutil`, `lsof` (who holds the port), asks GET /api/info, and reads
// the end of server.log and the result of the last install (launchd-install.json, written by install-launchd.sh).
// diagnose() turns the facts into one state with a reason and an action. It is a pure function, so tests give it facts.
// repair() runs the action of a fresh diagnosis, never one chosen by the caller:
// - install: scripts/install-launchd.sh of the current release (it loads the service, and puts the old one back on a
//   failure). It must run in the login session; the app runs there.
// - restart: launchctl kickstart -k of the service.
//
// Every command is found on PATH, so tests put fake launchctl, plutil and lsof programs first on PATH. The environment
// picks the service: TB_LAUNCHD_LABEL, TB_LAUNCHD_DIR, TASKBOARD_DIR and TASKBOARD_PORT, as in install-launchd.sh.
const { execFile } = require('node:child_process');
const { existsSync, readFileSync, openSync, readSync, fstatSync, closeSync, realpathSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

const REAL_LABEL = 'com.taskboard.server';
const STARTING_SEC = 60; // a server process younger than this that does not answer yet is still starting

function config(env = process.env) {
  const home = env.HOME || homedir();
  const tbDir = env.TASKBOARD_DIR || join(home, '.taskboard');
  const label = env.TB_LAUNCHD_LABEL || REAL_LABEL;
  return {
    env, label, tbDir, port: Number(env.TASKBOARD_PORT || 4317), app: join(tbDir, 'app'), log: join(tbDir, 'server.log'),
    plist: join(env.TB_LAUNCHD_DIR || join(home, 'Library', 'LaunchAgents'), `${label}.plist`),
    domain: `gui/${process.getuid ? process.getuid() : 0}`,
  };
}

// The app is started by the system with a short PATH; node and the Homebrew tools are added (the plist's PATH first).
function toolPath(cfg, plistPath) {
  const parts = [plistPath, cfg.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', join(cfg.env.HOME || homedir(), '.local/bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return [...new Set(parts.filter(Boolean).join(':').split(':').filter(Boolean))].join(':');
}

function run(cmd, args, cfg, timeout = 5000) {
  return new Promise(resolve => {
    execFile(cmd, args, { env: { ...cfg.env, PATH: toolPath(cfg) }, timeout, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || ''), err: String(stderr || (err && !stdout ? err.message : '') || '') }));
  });
}

function tail(file, lines = 12) {
  try {
    const fd = openSync(file, 'r'); const size = fstatSync(fd).size; const len = Math.min(size, 32 * 1024);
    const buf = Buffer.alloc(len); readSync(fd, buf, 0, len, size - len); closeSync(fd);
    return buf.toString('utf8').split('\n').filter(l => l.trim()).slice(-lines);
  } catch { return []; }
}
const readJson = f => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

// `launchctl print gui/<uid>/<label>`: the lines "state = running", "pid = 123", "last exit code = 1", "runs = 4"
function parsePrint(out) {
  const get = re => (out.match(re) || [])[1];
  const pid = Number(get(/^\s*pid = (\d+)/m)) || null;
  const exit = get(/^\s*last exit code = (.+)$/m);
  return { state: get(/^\s*state = (.+)$/m) || 'unknown', pid, lastExit: exit === undefined ? null : exit.trim(), runs: Number(get(/^\s*runs = (\d+)/m)) || 0 };
}
// `launchctl print-disabled gui/<uid>`: lines like "com.taskboard.server" => disabled (or => true on older systems)
function parseDisabled(out, label) {
  const m = out.match(new RegExp(`"${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" => (\\w+)`));
  return !!m && (m[1] === 'disabled' || m[1] === 'true');
}
// `ps -o etime=`: [[dd-]hh:]mm:ss
function etimeSec(s) {
  const m = String(s).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  return m ? ((+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3]) * 60 + (+m[4])) : null;
}

async function answers(cfg) {
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.port}/api/info`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    const j = await r.json().catch(() => ({}));
    return { pid: Number(j.pid) || null };
  } catch { return null; }
}

async function gather(cfg = config()) {
  const f = { platform: process.platform, label: cfg.label, plist: cfg.plist, app: cfg.app, log: cfg.log, port: cfg.port };
  if (process.platform !== 'darwin') return f;
  f.releaseExists = existsSync(join(cfg.app, 'server', 'index.ts'));
  try { f.release = realpathSync(cfg.app); } catch { f.release = null; }
  f.plistExists = existsSync(cfg.plist);
  if (f.plistExists) {
    f.plistValid = (await run('plutil', ['-lint', cfg.plist], cfg)).code === 0;
    const j = await run('plutil', ['-convert', 'json', '-o', '-', cfg.plist], cfg);
    try { const p = JSON.parse(j.out); f.program = (p.ProgramArguments || [])[0] || p.Program || null; f.plistPath = p.EnvironmentVariables?.PATH || null; } catch { f.program = null; }
  }
  const pr = await run('launchctl', ['print', `${cfg.domain}/${cfg.label}`], cfg);
  f.loaded = pr.code === 0;
  f.service = f.loaded ? parsePrint(pr.out) : null;
  f.disabled = parseDisabled((await run('launchctl', ['print-disabled', cfg.domain], cfg)).out, cfg.label);
  f.answer = await answers(cfg);
  f.portHolder = null;
  if (!f.answer) {
    const l = await run('lsof', ['-nP', `-iTCP:${cfg.port}`, '-sTCP:LISTEN', '-Fpc'], cfg);
    const pid = Number((l.out.match(/^p(\d+)/m) || [])[1]);
    if (pid) f.portHolder = { pid, command: (l.out.match(/^c(.+)$/m) || [])[1] || '' };
  }
  if (f.service?.pid) f.ageSec = etimeSec((await run('ps', ['-o', 'etime=', '-p', String(f.service.pid)], cfg)).out);
  f.logTail = tail(cfg.log);
  f.lastInstall = readJson(join(cfg.tbDir, 'launchd-install.json'));
  return f;
}

// One state for the facts. action: 'install' | 'restart' | 'wait' | null.
function diagnose(f) {
  const r = (state, ok, title, reason, action = null, extra = {}) => ({ state, ok, title, reason, action, label: f.label, ...extra });
  const atLogin = f.plistExists && f.plistValid !== false && !f.disabled;
  if (f.platform !== 'darwin' && f.releaseExists === undefined)
    return r('unsupported', false, 'No check for this system', 'The doctor checks the login service of a Mac. On Linux use scripts/install-systemd.sh; it prints the state.');
  if (f.answer) {
    const byService = f.loaded && f.service?.pid && f.answer.pid === f.service.pid;
    if (byService) return r('running', true, 'Taskboard server is running', `The login service runs it (process ${f.answer.pid}). It starts at login${atLogin ? '' : ', but the service file is missing or turned off'}.`, null, { startsAtLogin: atLogin, loaded: true });
    return r('running-by-hand', true, 'Taskboard server is running, but not as the login service', `Process ${f.answer.pid ?? 'unknown'} answers, and the login service does not run it${f.loaded ? '' : ' (the service is not loaded)'}. It will not start by itself after a restart of the computer.`, f.releaseExists ? 'install' : null, { startsAtLogin: atLogin, loaded: !!f.loaded });
  }
  if (!f.releaseExists) return r('release-missing', false, 'No Taskboard release', `${f.app} has no server. The login service runs a release, and there is none yet.`, null, { next: "Run 'pnpm release' in the Taskboard checkout." });
  if (!f.plistExists) return r('plist-missing', false, 'The login service is not installed', `${f.plist} does not exist, so nothing starts the server at login.`, 'install');
  if (f.plistValid === false) return r('plist-invalid', false, 'The login service file is damaged', `${f.plist} is not a valid property list.`, 'install');
  if (f.disabled) return r('disabled', false, 'The login service is turned off', `The label ${f.label} is disabled, so it does not start at login. System Settings > General > Login Items can turn it off.`, 'install');
  if (!f.loaded) return r('not-loaded', false, 'The login service is not loaded', `${f.plist} exists, but the service is not loaded now. This happens when an install was stopped halfway (the service was removed and not loaded again).`, 'install');
  if (f.portHolder && f.portHolder.pid !== f.service?.pid)
    return r('port-busy', false, `Port ${f.port} is used by another program`, `${f.portHolder.command || 'A program'} (process ${f.portHolder.pid}) listens on port ${f.port}, so the server cannot start.`, null, { next: `Quit ${f.portHolder.command || 'that program'} (process ${f.portHolder.pid}), then click Start server.`, logTail: f.logTail });
  const running = f.service?.state === 'running' && f.service?.pid;
  if (running && f.ageSec != null && f.ageSec < STARTING_SEC)
    return r('starting', false, 'Taskboard server is starting', `Process ${f.service.pid} started ${f.ageSec} s ago and does not answer yet. After a login the system starts login services about 20 to 60 s after the desktop appears.`, 'wait', { logTail: f.logTail });
  if (!running) {
    const exit = f.service?.lastExit && !/never exited/.test(f.service.lastExit) ? ` Its last exit code was ${f.service.lastExit}.` : '';
    return r('crashed', false, 'Taskboard server stopped', `The service is loaded but its process does not run.${exit} The service restarts it every 10 s, so it probably stops again at start. The last lines of the log are below.`, 'restart', { logTail: f.logTail });
  }
  return r('not-answering', false, 'Taskboard server does not answer', `Process ${f.service.pid} runs${f.ageSec != null ? ` for ${f.ageSec} s` : ''} but does not answer on port ${f.port}.`, 'restart', { logTail: f.logTail });
}

async function check(cfg = config()) { const facts = await gather(cfg); return { ...diagnose(facts), facts }; }

async function waitForAnswer(cfg, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await answers(cfg)) return true; await new Promise(r => setTimeout(r, 1000)); }
  return false;
}

// Runs the action that a fresh check offers. Returns { ok, line, before, after }.
async function repair(cfg = config()) {
  const before = await check(cfg);
  if (before.action === 'install') {
    const script = join(cfg.app, 'scripts', 'install-launchd.sh');
    if (!existsSync(script)) return { ok: false, line: `Not installed: ${script} is missing. Run 'pnpm release' in the Taskboard checkout.`, before };
    const env = { ...cfg.env, PATH: toolPath(cfg, before.facts.plistPath) };
    const res = await new Promise(resolve => execFile('/bin/sh', [script], { env, timeout: 120_000, encoding: 'utf8' }, (err, stdout, stderr) =>
      resolve({ code: err ? 1 : 0, text: `${stdout || ''}${stderr || ''}` })));
    const lines = res.text.split('\n').map(l => l.trim()).filter(Boolean);
    return { ok: res.code === 0, line: lines[lines.length - 1] || (res.code ? 'The install script failed without a message.' : 'Installed.'), output: lines.slice(-12), before, after: await check(cfg) };
  }
  if (before.action === 'restart') {
    const k = await run('launchctl', ['kickstart', '-k', `${cfg.domain}/${cfg.label}`], cfg, 15_000);
    if (k.code !== 0) return { ok: false, line: `The restart failed: ${(k.err || k.out).trim().split('\n')[0]}`, before };
    const up = await waitForAnswer(cfg, cfg.upWaitMs ?? 30_000);
    return { ok: up, line: up ? 'Taskboard server started and answers.' : 'The service restarted, but the server did not answer within 30 s. Read the log lines below.', before, after: await check(cfg) };
  }
  return { ok: before.ok, line: before.action === 'wait' ? 'The server is still starting. Wait a minute.' : before.next || before.title, before };
}

module.exports = { REAL_LABEL, config, gather, diagnose, check, repair, parsePrint, parseDisabled, etimeSec };
