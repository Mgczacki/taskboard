// Which folders running processes use, for two checks (shared by scripts/release.mjs, scripts/doctor.mjs and the
// server, server/tmux-health.ts):
//  - The release prune (pruneReleases) must not remove a release folder that a process still uses. On 4 October 2026
//    a release removed the folder that was the working directory of the tmux server of the socket taskboard. After
//    that, each new pane of that tmux server started in the deleted folder, and every new or resumed task failed.
//  - The tmux server check (tmuxServerFolder): the working directory of the tmux server, and whether it was deleted.
// lsof -F prints one field on each line: p<pid>, c<command>, f<file descriptor>, i<inode>, n<path>.
import { execFile } from 'node:child_process';
import { readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { sep } from 'node:path';

// The folder that Taskboard runs tmux and its own server from. A release never removes it.
export const STABLE_DIR = homedir();

const run = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, { cwd: STABLE_DIR, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (e, stdout) => (e && !stdout ? reject(e) : resolve(stdout))));

// lsof -F output → [{ pid, command, fd, inode, path }], one entry for each file
export function parseLsof(text) {
  const out = []; let pid = 0, command = '', cur = null;
  for (const line of text.split('\n')) {
    const k = line[0], v = line.slice(1);
    if (k === 'p') { pid = Number(v); command = ''; cur = null; }
    else if (k === 'c') command = v;
    else if (k === 'f') { cur = { pid, command, fd: v, inode: undefined, path: '' }; out.push(cur); }
    else if (k === 'i' && cur) cur.inode = Number(v);
    else if (k === 'n' && cur) cur.path = v;
  }
  return out;
}

// The working directory (cwd) and the program files (txt: the executable and loaded libraries, such as the node-pty
// addon of a release) of every process of this user. null when the list cannot be read: callers must then not assume
// that no process uses a folder.
export async function processFolders(exec = run) {
  try {
    const text = await exec('lsof', ['-nP', '-w', '-u', String(process.getuid()), '-a', '-d', 'cwd,txt', '-Fpcfn']);
    const files = parseLsof(text).filter(f => f.path);
    if (files.length) return files;
  } catch { /* no lsof, or it failed: try /proc below */ }
  if (process.platform !== 'linux') return null;
  const out = [];
  try {
    for (const p of readdirSync('/proc')) {
      if (!/^\d+$/.test(p)) continue;
      for (const [fd, link] of [['cwd', 'cwd'], ['txt', 'exe']]) {
        try { out.push({ pid: Number(p), command: '', fd, path: readlinkSync(`/proc/${p}/${link}`).replace(/ \(deleted\)$/, '') }); } catch { /* another user's process, or it ended */ }
      }
    }
  } catch { return null; }
  return out.length ? out : null;
}

// The release folders under `root` that a process uses: Map<release id, [{ pid, command, fd }]>.
export function releasesInUse(files, root) {
  const roots = new Set([root]); try { roots.add(realpathSync(root)); } catch { /* root missing */ }
  const used = new Map();
  for (const f of files) {
    for (const r of roots) {
      if (!f.path.startsWith(r + sep)) continue;
      const id = f.path.slice(r.length + 1).split(sep)[0];
      if (!used.has(id)) used.set(id, []);
      used.get(id).push({ pid: f.pid, command: f.command, fd: f.fd });
      break;
    }
  }
  return used;
}

// Which releases to keep and which to remove. ids: oldest first. current: the target of ~/.taskboard/app.
// previous: the release that ran before this release (pnpm rollback goes back to it). inUse: from releasesInUse, or
// null when the process list could not be read (then nothing is removed). Returns { keep: [{ id, reasons }], remove }.
export function planPrune({ ids, current, previous, newest = 5, inUse }) {
  const keep = [], remove = [];
  const newestIds = new Set(ids.slice(-newest));
  for (const id of ids) {
    const reasons = [];
    if (id === current) reasons.push('it is the current release (~/.taskboard/app)');
    if (id === previous) reasons.push('it is the previous release, for pnpm rollback');
    if (newestIds.has(id)) reasons.push(`it is one of the newest ${newest}`);
    if (!inUse) reasons.push('the list of running processes could not be read');
    for (const u of inUse?.get(id) || []) reasons.push(`process ${u.pid}${u.command ? ` (${u.command})` : ''} uses it (${u.fd === 'cwd' ? 'working directory' : 'program file'})`);
    if (reasons.length) keep.push({ id, reasons }); else remove.push(id);
  }
  return { keep, remove };
}

// The working directory of one process: { path, deleted } or null when it cannot be read.
// macOS lsof still prints the old path of a deleted folder, so a folder counts as deleted when the path is gone or
// now names another folder (another inode). Linux adds " (deleted)" to the path.
export async function cwdOf(pid, exec = run) {
  let f = null;
  try { f = parseLsof(await exec('lsof', ['-nP', '-w', '-a', '-p', String(pid), '-d', 'cwd', '-Fpfin'])).find(x => x.fd === 'cwd' && x.path) || null; } catch { /* no lsof */ }
  if (!f && process.platform === 'linux') { try { f = { path: readlinkSync(`/proc/${pid}/cwd`) }; } catch { /* gone */ } }
  if (!f) return null;
  if (/ \(deleted\)$/.test(f.path)) return { path: f.path.replace(/ \(deleted\)$/, ''), deleted: true };
  try { const s = statSync(f.path); return { path: f.path, deleted: f.inode !== undefined && s.ino !== f.inode }; }
  catch { return { path: f.path, deleted: true }; }
}

// The tmux server of `socket`: { pid, cwd, deleted } (cwd null when it cannot be read), or null when no tmux server
// runs on that socket. The tmux command runs from STABLE_DIR, so it never starts a server from another folder.
export async function tmuxServerFolder(socket, tmuxBin = 'tmux', exec = run) {
  let pid;
  try { pid = Number((await exec(tmuxBin, ['-L', socket, 'display-message', '-p', '#{pid}'])).trim()); } catch { return null; }
  if (!pid) return null;
  const c = await cwdOf(pid, exec);
  return { pid, cwd: c?.path ?? null, deleted: !!c?.deleted };
}

export const tmuxRestartCommand = (socket, tmuxBin = 'tmux') => `${tmuxBin} -L ${socket} kill-server`;

// The text that pnpm doctor, tb info and the dashboard show for a tmux server that runs from a deleted folder.
export function tmuxFolderProblem(s, socket, tmuxBin = 'tmux') {
  if (!s?.deleted) return null;
  return `The tmux server of the socket ${socket} (process ${s.pid}) runs from a deleted folder: ${s.cwd}. ` +
    'Programs that start in a new tmux pane without their own folder fail with "getcwd: cannot access parent directories". ' +
    `To remove the problem, restart the tmux server with \`${tmuxRestartCommand(socket, tmuxBin)}\` and then restart Taskboard. ` +
    'This ends every task session. Resume each task from the dashboard after that.';
}
