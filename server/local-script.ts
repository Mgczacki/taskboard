import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

// The operating system denies network access and signals. Node denies child processes and native extensions.
// Neither check reads report prose. Failure to install either restriction refuses this call.
export function localScriptExecution(argv: string[], cwd: string, taskFolder: string) {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))
    throw new Error('Local scripts need the macOS sandbox. Continue source work and report preparation.');
  if (argv.length !== 2 || !['node', process.execPath].includes(argv[0]) || !/\.(?:mjs|cjs|js)$/.test(argv[1]))
    throw new Error('Use --local-script with node and one JavaScript file. Interpreter options are not allowed.');
  const script = realpathSync(resolve(cwd, argv[1]));
  const outbox = realpathSync(join(taskFolder, 'outbox'));
  if (outbox !== join(realpathSync(taskFolder), 'outbox')) throw new Error('The outbox must not be a symlink.');
  const outboxPaths = [...new Set([outbox, join(taskFolder, 'outbox')])];
  const taskRoot = realpathSync(taskFolder), taskParent = dirname(taskRoot), working = realpathSync(cwd);
  const sourceRead = working !== taskRoot && working !== taskParent && !taskParent.startsWith(working + sep);
  const reads = [...new Set([script, resolve(cwd, argv[1]), ...outboxPaths,
    ...(sourceRead ? [cwd, working] : [])])];
  // JSON quoting also quotes sandbox profile paths. No task-provided profile text enters the rules.
  const protectedReads = [...new Set([homedir(), taskParent, '/Volumes', '/private/tmp', '/private/var/folders'])];
  const allowedReads = [...new Set([...reads.map(path => realpathSync(path)), dirname(dirname(realpathSync(process.execPath)))])];
  const readRule = `(deny file-read-data (require-all (require-any ${protectedReads.map(path => `(subpath ${JSON.stringify(path)})`).join(' ')}) ` +
    `${allowedReads.map(path => `(require-not (subpath ${JSON.stringify(path)}))`).join(' ')}))`;
  const profile = `(version 1)(allow default)(deny network*)(deny signal)(deny process-fork)` +
    `(deny process-exec (require-not (literal ${JSON.stringify(realpathSync(process.execPath))})))` +
    `(deny file-write* (require-not (subpath ${JSON.stringify(outbox)})))` + readRule;
  return { bin: '/usr/bin/sandbox-exec', args: ['-p', profile, process.execPath, '--experimental-permission',
    ...reads.map(path => '--allow-fs-read=' + path), ...outboxPaths.map(path => '--allow-fs-write=' + path), script] };
}

export function localScriptEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // A report does not need credentials or Node startup options from the server.
  return Object.fromEntries(Object.entries(env).filter(([name]) =>
    ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'].includes(name)));
}
