import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

// Checks what a task branch would publish: the files it changes against a base, and every file that any of its
// commits ever held. A later commit that deletes a file does not remove that file from the history that a push sends.
const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd, maxBuffer: 256 * 1024 * 1024 })).stdout;
function gitInput(cwd: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => code ? reject(new Error(err.trim() || `git ${args[0]} failed`)) : resolve(out));
    child.stdin.end(input);
  });
}

export const LARGE_FILE_BYTES = 5 * 1024 * 1024;
const dirNames = new Set(['credentials', '.credentials', 'secrets', '.secrets', '.aws', '.ssh', '.gnupg']);

// The reason a path must not be in a branch, or '' when the path is allowed.
export function riskyPath(path: string): string {
  const parts = path.split('/');
  const dirs = parts.slice(0, -1);
  const name = parts[parts.length - 1];
  if (parts.includes('node_modules')) return 'node_modules';
  if (parts.includes('.pnpm-store')) return '.pnpm-store';
  if (/^\.env(\..+)?$/.test(name) && !/^\.env\.(example|sample|template)$/.test(name)) return '.env file';
  if (dirs.some(d => dirNames.has(d)) || /(^|\/)\.config\/(gcloud|gh)\//.test(path)) return 'credentials folder';
  return '';
}

export const formatBytes = (n: number) => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`;

// Warnings for every file in the commits that `revs` selects, for example [head, '--not', base].
export async function scanHistory(cwd: string, revs: string[], limit = LARGE_FILE_BYTES): Promise<{ commits: number; warnings: string[] }> {
  const commits = Number((await git(cwd, 'rev-list', '--count', ...revs)).trim());
  const listed = (await git(cwd, 'rev-list', '--objects', ...revs)).split('\n').filter(Boolean)
    .map(line => { const i = line.indexOf(' '); return i < 0 ? { id: line, path: '' } : { id: line.slice(0, i), path: line.slice(i + 1) }; })
    .filter(o => o.path);
  const kinds = listed.length ? (await gitInput(cwd, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], listed.map(o => o.id).join('\n') + '\n'))
    .split('\n').filter(Boolean).map(line => line.split(' ')) : [];
  const sizes = new Map(kinds.filter(k => k[1] === 'blob').map(k => [k[0], Number(k[2])]));
  const large: string[] = [];
  const risky = new Map<string, string[]>();
  for (const o of listed) {
    const size = sizes.get(o.id);
    if (size === undefined) continue;
    if (size > limit) large.push(`${o.path} (${formatBytes(size)})`);
    const reason = riskyPath(o.path);
    if (reason) risky.set(reason, [...(risky.get(reason) || []), o.path]);
  }
  const warnings: string[] = [];
  if (large.length) warnings.push(`The history holds ${large.length} file${large.length === 1 ? '' : 's'} larger than ${formatBytes(limit)}: ${large.slice(0, 10).join(', ')}${large.length > 10 ? ', and more' : ''}.`);
  for (const [reason, paths] of risky) warnings.push(`The history holds ${paths.length} path${paths.length === 1 ? '' : 's'} of type ${reason}: ${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ', and more' : ''}.`);
  return { commits, warnings };
}

// The text that tb git repair, tb git rebase with a remote base, and tb git check print.
export async function historyReport(cwd: string, baseRef: string, baseName: string, head = 'HEAD', limit = LARGE_FILE_BYTES): Promise<string> {
  const branch = (await git(cwd, 'branch', '--show-current')).trim() || head;
  const changed = (await git(cwd, 'diff', '--name-status', '--no-renames', '-z', `${baseRef}...${head}`)).split('\0').filter(Boolean);
  const files: { status: string; path: string }[] = [];
  for (let i = 0; i + 1 < changed.length; i += 2) files.push({ status: changed[i], path: changed[i + 1] });
  const added = new Set(files.filter(f => f.status === 'A').map(f => f.path));
  let largest: { path: string; bytes: number } | null = null;
  if (added.size) {
    for (const entry of (await git(cwd, 'ls-tree', '-r', '-l', '-z', head)).split('\0')) {
      const tab = entry.indexOf('\t');
      if (tab < 0) continue;
      const path = entry.slice(tab + 1), bytes = Number(entry.slice(0, tab).trim().split(/\s+/)[3]);
      if (added.has(path) && Number.isFinite(bytes) && (!largest || bytes > largest.bytes)) largest = { path, bytes };
    }
  }
  const scan = await scanHistory(cwd, [head, '--not', baseRef], limit);
  const lines = [`Check of ${branch} against ${baseName}:`, `Files changed: ${files.length}`];
  for (const f of files.slice(0, 200)) lines.push(`  ${f.status} ${f.path}`);
  if (files.length > 200) lines.push(`  and ${files.length - 200} more files`);
  lines.push(largest ? `Largest added file: ${largest.path} (${formatBytes(largest.bytes)})` : 'Largest added file: none (the branch adds no files)');
  if (scan.warnings.length) lines.push(...scan.warnings.map(w => `Warning: ${w}`));
  else lines.push(`History check: the ${scan.commits} commit${scan.commits === 1 ? '' : 's'} after ${baseName} hold no file larger than ${formatBytes(limit)} and no node_modules, .pnpm-store, .env or credentials path.`);
  return lines.join('\n');
}
