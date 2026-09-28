// Which kind of Taskboard server this is, and the rules that keep a development copy away from the real one.
//
// - production: the real Taskboard of this machine. Uses the default ~/.taskboard, port 4317 and tmux socket
//   "taskboard", and runs from a release copy in ~/.taskboard/releases/<id> (made by `pnpm release`), never from a
//   checkout that agents edit.
// - sandbox: any server started with TASKBOARD_DIR set (`pnpm sandbox`). It must not share the port, folders or tmux
//   socket of production.
import { copyFileSync, chmodSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { HOME, PORT, ROOT, TB_DIR, TMUX_SOCKET, VAULT } from './config.ts';

export const DEFAULT_TB_DIR = join(HOME, '.taskboard');
export const ROLE: 'production' | 'sandbox' = process.env.TASKBOARD_DIR ? 'sandbox' : 'production';
export const RELEASES_DIR = join(TB_DIR, 'releases');

// Returns why this server must not start, or null.
export function refuseReason(): string | null {
  if (ROLE === 'sandbox') {
    const clash = [PORT === 4317 && 'port 4317', TMUX_SOCKET === 'taskboard' && 'tmux socket "taskboard"', realpathOr(TB_DIR) === realpathOr(DEFAULT_TB_DIR) && '~/.taskboard', realpathOr(VAULT) === realpathOr(join(HOME, 'AgentVault')) && '~/AgentVault'].filter(Boolean);
    return clash.length ? `A sandbox (TASKBOARD_DIR is set) must not use the real Taskboard's ${clash.join(', ')}. Use \`pnpm sandbox\`, which picks its own.` : null;
  }
  if (PORT !== 4317 || TMUX_SOCKET !== 'taskboard') return 'The real Taskboard uses port 4317 and tmux socket "taskboard". For another port or socket, set TASKBOARD_DIR as well (or use `pnpm sandbox`).';
  const root = realpathOr(ROOT);
  if (!root.startsWith(realpathOr(RELEASES_DIR) + sep) && !process.env.TASKBOARD_ALLOW_CHECKOUT)
    return `This is a development checkout (${ROOT}). The real Taskboard runs from a release: run \`pnpm release\` to build one and switch to it, or \`pnpm sandbox\` to try this code on its own port.`;
  return null;
}

function realpathOr(p: string) { try { return realpathSync(p); } catch { return p; } }

// Files the agents' CLIs run (hook scripts, status line, guard, notify) and `tb` are copied to a fixed place in
// TB_DIR on every start, so settings written for running agents keep working when releases are replaced or pruned.
export const RUNTIME_HOOKS = join(TB_DIR, 'hooks');
export const RUNTIME_BIN = join(TB_DIR, 'bin');
export function installRuntimeFiles() {
  mkdirSync(RUNTIME_HOOKS, { recursive: true }); mkdirSync(RUNTIME_BIN, { recursive: true });
  for (const f of readdirSync(join(ROOT, 'server', 'hooks'))) if (f.endsWith('.mjs')) copyFileSync(join(ROOT, 'server', 'hooks', f), join(RUNTIME_HOOKS, f));
  copyFileSync(join(ROOT, 'bin', 'tb'), join(RUNTIME_BIN, 'tb')); chmodSync(join(RUNTIME_BIN, 'tb'), 0o755);
  // tb uses ES module syntax; without this file next to it Node reads it as CommonJS and every tb command fails
  writeFileSync(join(RUNTIME_BIN, 'package.json'), '{ "type": "module" }\n');
}
