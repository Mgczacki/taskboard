import { execFile } from 'node:child_process';
import { existsSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function useTaskWorktree(folder: string, requested?: boolean): Promise<boolean> {
  if (requested !== undefined) return requested;
  try {
    const root = (await exec('git', ['-C', folder, 'rev-parse', '--show-toplevel'])).stdout.trim();
    return realpathSync(root) === realpathSync(folder);
  } catch { return false; }
}

export async function prepareWorktreeDependencies(folder: string, cwd: string): Promise<void> {
  const source = join(folder, 'node_modules');
  const target = join(cwd, 'node_modules');
  if (existsSync(target)) return;
  if (existsSync(source)) { symlinkSync(source, target, 'dir'); return; }
  if (!existsSync(join(cwd, 'package.json'))) return;
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) await exec('pnpm', ['install', '--frozen-lockfile'], { cwd });
  else if (existsSync(join(cwd, 'package-lock.json'))) await exec('npm', ['ci'], { cwd });
  else if (existsSync(join(cwd, 'yarn.lock'))) await exec('yarn', ['install', '--frozen-lockfile'], { cwd });
}
