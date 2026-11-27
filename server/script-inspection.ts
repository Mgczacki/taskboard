import { parse } from 'acorn';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { TB_DIR, PORT, TMUX_SOCKET } from './config.ts';
import { commandCalls, gitOperation, pathArguments, productionWrite, runsScript } from './hooks/script-command.mjs';

function checkWrites(paths: string[], cwd: string) {
  const installation = realpathSync(TB_DIR);
  const physical = (path: string): string => existsSync(path) ? realpathSync(path) : resolve(physical(dirname(path)), path.slice(dirname(path).length + 1));
  for (const value of paths) {
    if (!value || value.startsWith('-') || value.includes('://')) continue;
    const path = physical(resolve(cwd, value.replace(/^(?:~|\$HOME)(?=\/)/, homedir())));
    if (path === installation || path.startsWith(installation + sep) || installation.startsWith(path + sep))
      throw new Error('A protected Taskboard operation needs its own user decision.');
  }
}

export function inspectShell(source: string, cwd = process.cwd()) {
  const paths: string[] = [];
  const calls = commandCalls(source);
  let pid = '';
  try { pid = String(JSON.parse(readFileSync(join(TB_DIR, 'server.pid'), 'utf8')).pid); } catch { /* no server */ }
  const markers = calls.filter(w => ['kill', 'pkill', 'killall', 'cat', 'pgrep', 'lsof', 'fuser'].includes(w[0])).flat().join(' ');
  if (calls.some(w => ['kill', 'pkill', 'killall', 'fuser'].includes(w[0])) &&
      (calls.some(w => w[0] === 'kill' && pid && w.slice(1).includes(pid)) ||
       /server\.pid|server\/index|\btsx\b|\.taskboard\b/.test(markers) || new RegExp(`[:=\\s]${PORT}\\b`).test(markers)))
    throw new Error('A protected Taskboard operation needs its own user decision.');
  for (const words of calls) {
    const [bin, ...args] = words;
    if (bin === 'git' && gitOperation(words).sub === 'push' || bin === 'gh' && args.some(a => ['repo', 'pr', 'api'].includes(a)))
      throw new Error('A GitHub write needs a separate user decision.');
    if (['release', 'rollback', 'restart', 'stop'].some(name => runsScript(words, name)) ||
        bin === 'tb' && args[0] === 'restart' || bin === 'launchctl' || productionWrite(words))
      throw new Error('A protected Taskboard operation needs its own user decision.');
    if (bin === 'unclassified-code' || bin === 'tmux' && args[args.indexOf('-L') + 1] === TMUX_SOCKET && args.some(a => ['kill-server', 'kill-session'].includes(a)))
      throw new Error('A protected Taskboard operation needs its own user decision.');
    if (['rm', 'mv', 'cp', 'rsync', 'tee', 'touch', 'mkdir', 'install', 'truncate', 'chmod', 'chown', 'ln', 'write-file'].includes(bin)) checkWrites(pathArguments(words).slice(1), cwd);
    checkWrites(args.filter((_arg, i) => args[i - 1] === '>'), cwd);
    paths.push(...pathArguments(words));
  }
  return paths;
}

// Parse JavaScript syntax. Text in a report is not an executable command.
// General code review cannot prove arbitrary JavaScript safe. Use the local runtime when effects are unknown.
export function inspectJavaScript(source: string, cwd = process.cwd()) {
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const paths: string[] = [];
  function visit(node: any) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'MemberExpression') {
      const property = node.computed ? node.property.value : node.property.name;
      const object = node.object.name || node.object.property?.name;
      if (object === 'process' && ['getBuiltinModule', 'binding', '_linkedBinding', 'dlopen', 'mainModule', 'execve'].includes(property) || object === 'module' && property === 'require')
        throw new Error('Use --local-script for a local Node report. This process capability needs a separate review.');
    }
    if (node.type === 'ImportDeclaration') {
      const name = node.source.value.replace(/^node:/, '');
      if (!['fs', 'fs/promises', 'path', 'os', 'url', 'util', 'assert', 'assert/strict'].includes(name))
        throw new Error('Use --local-script for a local Node report. This script imports code that needs a separate review.');
    }
    if (node.type === 'CallExpression') {
      const name = source.slice(node.callee.start, node.callee.end);
      if (/\b(readFile|readFileSync|writeFile|writeFileSync|appendFile|appendFileSync|readdir|readdirSync|unlink|unlinkSync|rm|rmSync|mkdir|mkdirSync|copyFile|copyFileSync|rename|renameSync)$/.test(name)) {
        for (const arg of node.arguments.slice(0, /\b(copyFile|copyFileSync|rename|renameSync)$/.test(name) ? 2 : 1))
          if (arg.type === 'Literal' && typeof arg.value === 'string') {
            paths.push(arg.value);
            if (!/\b(readFile|readFileSync|readdir|readdirSync)$/.test(name)) checkWrites([arg.value], cwd);
          }
      }
      if (/\b(exec|execSync|execFile|execFileSync|spawn|spawnSync)$/.test(name)) {
        const first = node.arguments[0];
        if (first?.type === 'Literal' && typeof first.value === 'string') {
          let words: string[];
          if (/\bexec(?:Sync)?$/.test(name)) { inspectShell(first.value, cwd); words = []; }
          else {
            const args = node.arguments[1];
            if (args && (args.type !== 'ArrayExpression' || !args.elements.every((a: any) => a?.type === 'Literal' && typeof a.value === 'string')))
              throw new Error('Use --local-script for code that constructs a process command.');
            words = [first.value, ...(args?.type === 'ArrayExpression' ? args.elements.map((a: any) => a.value) : [])];
            inspectShell(words.map(w => JSON.stringify(w)).join(' '), cwd);
          }
        } else throw new Error('Use --local-script for code that constructs a process command.');
      }
      if (['require', 'eval', 'Function', 'process.kill', 'process.binding', 'process.dlopen'].includes(name))
        throw new Error('Use --local-script for a local Node report. This code needs a separate review.');
    }
    if (node.type === 'ImportExpression' || node.type === 'NewExpression' && source.slice(node.callee.start, node.callee.end) === 'Function')
      throw new Error('Use --local-script for a local Node report. This code needs a separate review.');
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(tree);
  return paths;
}

export function inspectPython(source: string, cwd = process.cwd()) {
  const result = spawnSync('python3', ['-I', '-S', fileURLToPath(new URL('./hooks/script-commands.py', import.meta.url))],
    { input: source, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error('The Python process calls could not be checked. Use --local-script for a Node report or request each command separately.');
  const data = JSON.parse(result.stdout) as { commands: (string | string[])[]; paths: string[]; writes: string[] };
  checkWrites(data.writes, cwd);
  return [...data.paths, ...data.commands.flatMap(command => inspectShell(typeof command === 'string' ? command : command.map(w => JSON.stringify(w)).join(' '), cwd))];
}
