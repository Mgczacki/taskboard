// Keep quoted arguments together. Shell substitutions execute even inside double quotes.
// This scan only classifies commands. It does not change the forms that a release permit accepts.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

function pythonCalls(source) {
  const result = spawnSync('python3', ['-I', '-S', fileURLToPath(new URL('./script-commands.py', import.meta.url))],
    { input: source, encoding: 'utf8', timeout: 1500, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) return [['unclassified-code']];
  try {
    const data = JSON.parse(result.stdout);
    return [...data.commands.flatMap(c => typeof c === 'string' ? commandCalls(c) : [c]), ...data.writes.map(path => ['write-file', path])];
  } catch { return [['unclassified-code']]; }
}

let parseJavaScript;
function javascriptCalls(source) {
  if (!parseJavaScript) {
    try { parseJavaScript = createRequire(import.meta.url)('./command-parser.cjs').parse; } catch { /* source checkout */ }
    // Source hooks use the checkout. Installed hooks use the active release, including while the server is down.
    for (const path of parseJavaScript ? [] : ['../../package.json', '../app/package.json']) {
      try { parseJavaScript = createRequire(new URL(path, import.meta.url))('acorn').parse; break; } catch { /* try the installed release */ }
    }
  }
  if (!parseJavaScript) return [['unclassified-code']];
  let tree;
  try { tree = parseJavaScript(source, { ecmaVersion: 'latest', sourceType: 'module' }); }
  catch { return [['unclassified-code']]; }
  const calls = [];
  function visit(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'ImportDeclaration') calls.push(['node', node.source.value]);
    if (node.type === 'ImportExpression' || node.type === 'CallExpression' && node.callee.name === 'require') {
      const value = node.source || node.arguments[0];
      if (value?.type === 'Literal' && typeof value.value === 'string') calls.push(['node', value.value]);
    }
    if (node.type === 'CallExpression') {
      const name = node.callee.name || node.callee.property?.name;
      const values = node.arguments;
      const first = values[0];
      if (['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync'].includes(name)) {
        if (first?.type !== 'Literal' || typeof first.value !== 'string') calls.push(['unclassified-code']);
        else if (['exec', 'execSync'].includes(name)) calls.push(...commandCalls(first.value));
        else if (!values[1] || values[1].type === 'ArrayExpression' && values[1].elements.every(a => a?.type === 'Literal' && typeof a.value === 'string'))
          calls.push([first.value, ...(values[1]?.elements.map(a => a.value) || [])]);
        else calls.push(['unclassified-code']);
      }
      if (name === 'kill' && node.callee.object?.name === 'process')
        calls.push(['kill', first?.type === 'Literal' ? String(first.value) : '<dynamic>']);
      if (['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'unlink', 'unlinkSync', 'rm', 'rmSync'].includes(name) && first?.type === 'Literal')
        calls.push(['write-file', String(first.value)]);
      if (['eval', 'Function'].includes(name)) calls.push(['unclassified-code']);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(tree);
  return calls;
}
export function commandWords(source) {
  const commands = [];
  const inputCommands = [];
  const heredocs = [];
  let i = 0, hasInputOperator = false;
  function scan(end = '') {
    let words = [], word = '', active = false, quote = '', receivesInput = false;
    const flushWord = () => { if (active) words.push(word); word = ''; active = false; };
    const flushCommand = () => { flushWord(); if (words.length) { commands.push(words); if (receivesInput) inputCommands.push({ words }); } words = []; receivesInput = false; };
    while (i < source.length) {
      const c = source[i++];
      if (!quote && end && c === end) break;
      if (quote === "'") {
        if (c === quote) quote = ''; else word += c;
        continue;
      }
      if (c === '\\' && i < source.length && (!quote || /["\\$`\n]/.test(source[i]))) {
        const next = source[i++];
        if (next !== '\n') { word += next; active = true; }
        continue;
      }
      if (c === '$' && source[i] === '(') {
        i++; scan(')'); word += '$()'; active = true; continue;
      }
      if (c === '`') { scan('`'); word += '` `'; active = true; continue; }
      if (quote === '"') {
        if (c === quote) quote = ''; else word += c;
        continue;
      }
      if (c === "'" || c === '"') { quote = c; active = true; continue; }
      if (c === '#' && !active) { while (i < source.length && source[i] !== '\n') i++; continue; }
      if (c === '<' && source[i] === '<' && source[i + 1] === '<') {
        i += 2; receivesInput = true; hasInputOperator = true; continue;
      }
      if (c === '<' && source[i] === '<') {
        flushWord(); i++; hasInputOperator = true;
        const tabs = source[i] === '-'; if (tabs) i++;
        while (/[ \t]/.test(source[i] || '\0')) i++;
        let delimiter = '', delimiterQuote = '', literal = false;
        while (i < source.length) {
          const next = source[i];
          if (!delimiterQuote && /[\s;&|]/.test(next)) break;
          i++;
          if (next === "'" || next === '"') {
            literal = true;
            if (delimiterQuote === next) delimiterQuote = '';
            else if (!delimiterQuote) delimiterQuote = next;
            else delimiter += next;
          } else if (next === '\\' && !delimiterQuote) { literal = true; delimiter += source[i++] || ''; }
          else delimiter += next;
        }
        heredocs.push({ delimiter, literal, tabs });
        continue;
      }
      if (c === '\n' && heredocs.length) {
        const consumer = words;
        flushWord();
        flushCommand();
        for (const doc of heredocs.splice(0)) {
          let body = '';
          while (i < source.length) {
            const end = source.indexOf('\n', i);
            const line = source.slice(i, end < 0 ? source.length : end);
            i = end < 0 ? source.length : end + 1;
            if ((doc.tabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) break;
            body += line + '\n';
          }
          if (!doc.literal) commands.push(...heredocExpansions(body));
          inputCommands.push({ words: consumer, body });
        }
        continue;
      }
      if (c === '<' || c === '|' && source[i] !== '|' && source[i - 2] !== '|') hasInputOperator = true;
      if (/[;&|\n(){}]/.test(c)) { flushCommand(); if (c === '|' && source[i] !== '|' && source[i - 2] !== '|') receivesInput = true; continue; }
      if (c === '<' || c === '>') { flushWord(); if (c === '<') receivesInput = true; if (c === '>') { words.push('>'); if (source[i] === '>') i++; } continue; }
      if (/\s/.test(c)) { flushWord(); continue; }
      word += c; active = true;
    }
    flushCommand();
  }
  scan();
  return { commands, hasInputOperator, inputCommands };
}

function heredocExpansions(source) {
  const calls = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\\') { i++; continue; }
    if (source[i] !== '`' && source.slice(i, i + 2) !== '$(') continue;
    const tick = source[i] === '`';
    const start = i + (tick ? 1 : 2);
    let depth = 1, quote = '', end = start;
    for (; end < source.length; end++) {
      const c = source[end];
      if (c === '\\') { end++; continue; }
      if (tick && c === '`') break;
      if (c === "'" || c === '"') { if (quote === c) quote = ''; else if (!quote) quote = c; continue; }
      if (!tick && !quote) {
        if (c === '(') depth++;
        if (c === ')' && --depth === 0) break;
      }
    }
    calls.push(...commandWords(source.slice(start, end)).commands); i = end;
  }
  return calls;
}

const executableName = word => (word || '').split('/').pop();
function commandStart(words) {
  let i = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] || '') || /^(?:if|then|do|else|elif|while|until|!|time|command|exec)$/.test(words[i] || '')) {
    const prefix = words[i++];
    if (prefix === 'time' || prefix === 'command') while (['-p', '--'].includes(words[i])) i++;
    if (prefix === 'exec') {
      while (['-a', '-c', '-l', '--'].includes(words[i])) { if (words[i++] === '-a') i++; }
    }
  }
  return i;
}
// Options that take a separate value before a package manager's command or script name.
const optionValue = new Set(['--dir', '-C', '--cwd', '--prefix', '--filter', '-F', '--workspace', '--package', '-p', '--cache', '--userconfig', '--registry']);
function afterOptions(words, i) {
  while (words[i]?.startsWith('-')) {
    const option = words[i++];
    if (option === '--') break;
    if (optionValue.has(option)) i++;
  }
  return i;
}
export function runsScript(words, script) {
  let i = commandStart(words);
  const bin = executableName(words[i++]);
  if (!bin) return false;
  if (bin === 'eval') return runsShellScript(words.slice(i).join(' '), script);
  if (bin === 'source' || bin === '.') return executableName(words[i]) === `${script}.mjs`;
  if (bin === `${script}.mjs`) return true;
  if (bin === 'env') {
    while (words[i]?.startsWith('-')) {
      const option = words[i++];
      if (option === '-S' || option === '--split-string') return runsShellScript(words.slice(i).join(' '), script);
      if (option === '-u' || option === '--unset' || option === '-C' || option === '--chdir') i++;
      if (option === '--') break;
    }
    return runsScript(words.slice(i), script);
  }
  if (['sudo', 'nohup', 'xargs'].includes(bin)) {
    while (words[i]?.startsWith('-')) {
      if (['-u', '-g', '-h', '-p', '-n', '-I'].includes(words[i++])) i++;
    }
    return runsScript(words.slice(i), script);
  }
  if (['timeout', 'gtimeout', 'nice', 'setsid'].includes(bin)) return runsScript(afterWrapper(words, i, bin), script);
  if (/^python[0-9.]*$/.test(bin)) {
    const c = words.indexOf('-c', i);
    return c !== -1 && pythonCalls(words[c + 1] || '').some(call => runsScript(call, script));
  }
  if (['sh', 'bash', 'zsh', 'dash'].includes(bin)) {
    const c = words.findIndex((w, j) => j >= i && /^-[a-z]*c[a-z]*$/.test(w));
    return c !== -1 && runsShellScript(words[c + 1] || '', script);
  }
  if (['pnpm', 'npm', 'yarn', 'bun', 'npx'].includes(bin)) {
    const start = i;
    if (bin === 'npx') {
      for (let j = i; words[j]?.startsWith('-'); j++) {
        if (words[j] === '-c' || words[j] === '--call') return runsShellScript(words[j + 1] || '', script);
        if (words[j].startsWith('--call=')) return runsShellScript(words[j].slice(7), script);
        if (words[j] === '--') break;
        if (optionValue.has(words[j])) j++;
      }
    }
    i = afterOptions(words, i);
    const sub = words[i++];
    if (sub === script && ['pnpm', 'yarn', 'npx'].includes(bin)) return true;
    if (sub === 'run' || sub === 'run-script') {
      const name = words[afterOptions(words, i)];
      return name === script || executableName(name) === `${script}.mjs`;
    }
    if (bin === 'npm' && sub === 'exec') return runsScript(['npx', ...words.slice(i)], script);
    if (['exec', 'dlx', 'x'].includes(sub)) return runsScript(words.slice(afterOptions(words, i)), script);
    if (bin === 'npx') return runsScript(words.slice(i - 1), script);
    if (bin !== 'bun') return false;
    i = start;
  }
  if (bin === 'tb' || bin === 'tb.mjs') {
    // These operations contain a command to run or to submit for approval, rather than message text.
    const command = words.indexOf('--command', i);
    if (command !== -1 && ['permit', 'suggest'].includes(words[i]))
      return runsShellScript(words[command + 1] || '', script);
    if (words[i] === 'suggest') return runsShellScript(words[i + 1] || '', script);
    if (words[i] === 'run') {
      const start = words.indexOf('--', i);
      return start !== -1 && runsShellScript(words.slice(start + 1).join(' '), script);
    }
    // Only the known tb path receives the literal-message exemption above.
    return words.slice(i).some(w => runsShellScript(w, script));
  }
  // A script file passed directly to an interpreter still runs when its path is quoted.
  if (['node', 'nodejs', 'bun', 'tsx', 'deno'].includes(bin)) {
    if (bin === 'deno' && words[i] === 'run') i++;
    let check = false, tests = false, found = false;
    const values = ['--test-name-pattern', '--test-skip-pattern', '--test-reporter', '--test-reporter-destination', '--test-timeout', '--test-concurrency', '--input-type', '--conditions', '-C', '--cpu-prof-dir', '--heap-prof-dir', '--title'];
    for (; i < words.length; i++) {
      const word = words[i];
      if (word === '--check' || word === '-c') { check = true; continue; }
      if (word === '--test') { tests = true; continue; }
      if (values.includes(word)) { i++; continue; }
      // Evaluated code can start a process or import a script. Keep the previous conservative check for that code.
      if (/^(?:-e|-p|--eval|--print)(?:=|$)/.test(word)) {
        const code = word.includes('=') ? word.slice(word.indexOf('=') + 1) : words[i + 1] || '';
        return javascriptCalls(code).some(call => runsScript(call, script));
      }
      if (['--import', '--require', '-r', '--loader', '--experimental-loader'].includes(word)) {
        if (executableName(words[++i]) === `${script}.mjs`) return true;
      } else if (!word.startsWith('-')) {
        if (check) return false;
        if (!tests) return executableName(word) === `${script}.mjs`;
        found ||= executableName(word) === `${script}.mjs`;
      }
    }
    return found;
  }
  // rg can execute its --pre argument before it searches a file.
  if (bin === 'rg') {
    const pre = words.findIndex(w => w === '--pre' || w.startsWith('--pre='));
    if (pre !== -1) return runsShellScript(words[pre].includes('=') ? words[pre].slice(6) : words[pre + 1] || '', script);
  }
  return false;
}
export function runsShellScript(command, script) {
  const { commands, hasInputOperator } = commandWords(command);
  if (commands.some(words => runsScript(words, script))) return true;
  // Reading a script into an interpreter runs it. Keep this refusal for pipelines and input redirects.
  return hasInputOperator && commands.some(w => ['node', 'nodejs', 'bun', 'tsx'].includes(executableName(w[0]))) &&
    commands.some(w => w.some(arg => executableName(arg) === `${script}.mjs`));
}

// Return executable calls, including commands inside shell substitutions and known wrappers.
export function commandCalls(source) {
  const result = [];
  function visit(words, depth = 0) {
    if (depth > 20) throw new Error('Command nesting exceeds 20 levels.');
    let i = commandStart(words);
    const bin = executableName(words[i++]);
    if (!bin) return;
    if (bin.startsWith('$') || bin.startsWith('`')) { result.push(['unclassified-code']); return; }
    if (bin === 'env') {
      while (words[i]?.startsWith('-')) {
        const option = words[i++];
        if (option === '-S' || option === '--split-string') { nested(words.slice(i).join(' '), depth); return; }
        if (['-u', '--unset', '-C', '--chdir'].includes(option)) i++;
        if (option === '--') break;
      }
      visit(words.slice(i), depth + 1); return;
    }
    if (['sudo', 'nohup', 'xargs'].includes(bin)) {
      while (words[i]?.startsWith('-')) if (['-u', '-g', '-h', '-p', '-n', '-I'].includes(words[i++])) i++;
      visit(words.slice(i), depth + 1); return;
    }
    if (['timeout', 'gtimeout', 'nice', 'setsid'].includes(bin)) { visit(afterWrapper(words, i, bin), depth + 1); return; }
    if (['sh', 'bash', 'zsh', 'dash'].includes(bin)) {
      const c = words.findIndex((w, j) => j >= i && /^-[a-z]*c[a-z]*$/.test(w));
      if (c !== -1) { nested(words[c + 1] || '', depth); return; }
    }
    const args = words.slice(i);
    result.push([bin, ...args]);
    if (['pnpm', 'npm', 'yarn', 'bun', 'npx'].includes(bin)) {
      const start = afterOptions(args, 0), action = args[start];
      if (bin === 'npx') visit(args.slice(start), depth + 1);
      else if (['exec', 'dlx', 'x'].includes(action)) visit(args.slice(afterOptions(args, start + 1)), depth + 1);
    }
    if (bin === 'eval') { nested(args.join(' '), depth); return; }
    if (bin === 'find') {
      const action = args.findIndex(arg => ['-exec', '-execdir', '-ok', '-okdir'].includes(arg));
      if (action !== -1) {
        const end = args.findIndex((arg, index) => index > action && [';', '+'].includes(arg));
        visit(args.slice(action + 1, end < 0 ? args.length : end), depth + 1);
      }
    }
    if (/^python[0-9.]*$/.test(bin) && args.includes('-c'))
      for (const call of pythonCalls(args[args.indexOf('-c') + 1] || '')) visit(call, depth + 1);
    if (['node', 'nodejs', 'bun', 'tsx'].includes(bin)) {
      const evaluated = args.findIndex(w => /^(?:-e|-p|--eval|--print)(?:=|$)/.test(w));
      if (evaluated !== -1) {
        const word = args[evaluated];
        for (const call of javascriptCalls(word.includes('=') ? word.slice(word.indexOf('=') + 1) : args[evaluated + 1] || '')) visit(call, depth + 1);
      }
    }
    if (bin === 'tb') {
      if (args[0] === 'suggest') nested(args[1] || '', depth);
      const command = args.indexOf('--command');
      if (args[0] === 'permit' && command !== -1) nested(args[command + 1] || '', depth);
      const separator = args.indexOf('--');
      if (args[0] === 'run' && separator !== -1) nested(args.slice(separator + 1).join(' '), depth);
    }
    if (bin === 'rg') {
      const pre = args.findIndex(w => w === '--pre' || w.startsWith('--pre='));
      if (pre !== -1) nested(args[pre].includes('=') ? args[pre].slice(6) : args[pre + 1] || '', depth);
    }
  }
  function nested(text, depth) {
    const parsed = commandWords(text);
    for (const words of parsed.commands) visit(words, depth + 1);
    for (const input of parsed.inputCommands) {
      const bin = executableName(input.words[0]), args = input.words.slice(1);
      const python = /^python[0-9.]*$/.test(bin || '');
      if (!python && !['node', 'nodejs', 'bun', 'tsx'].includes(bin) || args.some(w => /^(?:--test|--check|-c|-e|-p|--eval|--print)$/.test(w))) continue;
      let file = '';
      for (let i = 0; i < args.length; i++) {
        if (['--import', '--require', '-r', '--loader', '--experimental-loader', '--input-type'].includes(args[i])) { i++; continue; }
        if (!args[i].startsWith('-') || args[i] === '-') { file = args[i]; break; }
      }
      if (file && file !== '-') continue;
      if (input.body !== undefined) for (const words of python ? pythonCalls(input.body) : javascriptCalls(input.body)) visit(words, depth + 1);
      else result.push(['unclassified-code']);
    }
  }
  nested(source, 0);
  return result;
}

function afterWrapper(words, i, bin) {
  while (words[i]?.startsWith('-')) {
    if (['-s', '--signal', '-k', '--kill-after', '-n', '--adjustment'].includes(words[i++])) i++;
  }
  if (bin === 'timeout' || bin === 'gtimeout') i++;
  return words.slice(i);
}

export function gitOperation(words) {
  let i = 1;
  while (words[i]?.startsWith('-')) {
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(words[i++])) i++;
  }
  return { sub: words[i], args: words.slice(i + 1) };
}

export function gitReadOnly(words) {
  const { sub, args } = gitOperation(words);
  if (sub === 'stash') return ['list', 'show'].includes(args[0]);
  if (sub === 'worktree') return args[0] === 'list';
  if (!['branch', 'tag'].includes(sub)) return false;
  let patterns = false;
  const takesValue = ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--format', '--sort', '--color', '--column'];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--list', '-l'].includes(arg)) { patterns = true; continue; }
    if (['-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--show-current', '--no-color', '--no-column', '--ignore-case'].includes(arg)) continue;
    if (takesValue.some(option => arg.startsWith(option + '='))) continue;
    if (takesValue.includes(arg)) { if (args[i + 1] && !args[i + 1].startsWith('-')) i++; continue; }
    if (arg.startsWith('-') || !patterns) return false;
  }
  return true;
}

export function pathArguments(words) {
  const [executable, ...args] = words;
  const bin = executableName(executable);
  if (['echo', 'printf'].includes(bin)) return [executable];
  if (!['rg', 'grep', 'egrep', 'fgrep'].includes(bin)) return words;
  const paths = [executable];
  let pattern = false;
  const textOptions = ['-e', '--regexp', '-g', '--glob', '--iglob', '--type', '-t', '--type-not', '-T', '--pre', '--pre-glob'];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (textOptions.includes(arg)) { if (arg === '-e' || arg === '--regexp') pattern = true; i++; continue; }
    if (textOptions.some(option => arg.startsWith(option + '='))) { if (arg.startsWith('--regexp=')) pattern = true; continue; }
    if (['-f', '--file', '--ignore-file'].includes(arg)) { paths.push(args[++i] || ''); if (arg !== '--ignore-file') pattern = true; continue; }
    if (arg.startsWith('-')) continue;
    if (!pattern) { pattern = true; continue; }
    paths.push(arg);
  }
  return paths;
}

// Production changes stay outside the local command route. Read commands do not match this rule.
export function productionWrite(words) {
  const [executable, ...args] = words;
  const bin = executableName(executable);
  const production = args.some(a => /(?:^|[^a-z])prod(?:uction)?(?:[^a-z]|$)/i.test(a));
  if (!production) return false;
  if (['pnpm', 'npm', 'yarn', 'bun', 'npx'].includes(bin)) return runsScript(words, 'deploy');
  if (bin === 'kubectl') return args.some(a => ['apply', 'delete', 'patch', 'replace', 'edit', 'scale', 'rollout', 'set', 'create'].includes(a));
  if (bin === 'helm') return args.some(a => ['install', 'upgrade', 'rollback', 'uninstall', 'delete'].includes(a));
  if (bin === 'aws') return args.some(a => /^(?:update|create|delete|put|modify|execute|run|start|stop|terminate|deploy|register|deregister|send|batch-write)/.test(a));
  if (['psql', 'mysql', 'mongosh', 'redis-cli'].includes(bin)) return true;
  if (['gcloud', 'terraform', 'pulumi'].includes(bin)) return args.some(a => ['deploy', 'apply', 'destroy', 'delete', 'update', 'create', 'up'].includes(a));
  return false;
}

export function runsServerStop(source, tbDir) {
  const physical = path => { try { return realpathSync(path); } catch { return resolve(path); } };
  const commands = commandWords(source).commands;
  return commands.some(words => {
    if (!runsScript(words, 'stop')) return false;
    const setting = words.find(w => w.startsWith('TASKBOARD_DIR='));
    const target = setting?.slice('TASKBOARD_DIR='.length);
    return !target || !isAbsolute(target) || /[$`]/.test(target) || physical(target) === physical(tbDir);
  }) || !commands.some(words => runsScript(words, 'stop')) && commandCalls(source).some(words => runsScript(words, 'stop'));
}
