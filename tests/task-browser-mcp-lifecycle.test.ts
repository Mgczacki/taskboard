// The task-browser MCP wrapper and its chrome-devtools-mcp child must end when the agent that started them ends.
// Each case starts a scratch parent process in the role of the agent, and signals only the PIDs that it started.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const NODE = ['/opt/homebrew/opt/node@22/bin/node', process.execPath].find(existsSync)!;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const childrenOf = (pid: number) => execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', maxBuffer: 1 << 24 })
  .trim().split('\n').map(line => line.trim().split(/\s+/).map(Number)).filter(([, ppid]) => ppid === pid).map(([p]) => p);

// The parent starts the wrapper with the arguments that mcpServer() writes, completes the MCP handshake, and writes the
// PIDs to a file. With "hold", a second child inherits the write end of the wrapper's stdin and keeps it open.
const PARENT = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [out, mode, ...cmd] = process.argv.slice(2);
const server = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
const holder = mode === 'hold' ? spawn('/bin/sleep', ['60'], { stdio: ['ignore', 'ignore', 'ignore', server.stdin] }) : null;
let text = '';
server.stdout.on('data', data => { text += data; if (text.includes('"id":2')) writeFileSync(out, JSON.stringify({ server: server.pid, holder: holder?.pid })); });
const send = message => server.stdin.write(JSON.stringify(message) + '\\n');
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'parent', version: '1' } } });
setTimeout(() => { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }); }, 300);
setInterval(() => {}, 1000);
`;

async function startTree(mode: 'plain' | 'hold') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-mcp-life-')));
  writeFileSync(join(root, 'parent.mjs'), PARENT);
  const out = join(root, 'pids.json');
  const parent = spawn(NODE, [join(root, 'parent.mjs'), out, mode, NODE, '--import', resolve('node_modules/tsx/dist/loader.mjs'),
    resolve('server/task-browser-mcp.ts'), '--click-evidence', resolve('node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'),
    '--wsEndpoint', 'ws://127.0.0.1:1', '--no-usage-statistics', '--no-performance-crux'], { stdio: 'ignore' });
  for (let i = 0; i < 150 && !existsSync(out); i++) await sleep(100);
  const pids = JSON.parse(readFileSync(out, 'utf8')) as { server: number; holder?: number };
  let child: number | undefined;
  for (let i = 0; i < 50 && !child; i++) { child = childrenOf(pids.server)[0]; if (!child) await sleep(100); }
  assert.ok(child, 'the wrapper started chrome-devtools-mcp');
  const tree = { parent: parent.pid!, wrapper: pids.server, child, holder: pids.holder };
  const cleanup = () => {
    for (const pid of [tree.parent, tree.wrapper, tree.child, tree.holder]) if (pid && alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ }
    rmSync(root, { recursive: true, force: true });
  };
  return { tree, cleanup };
}

async function count(tree: { wrapper: number; child: number }, waitMs: number) {
  for (let waited = 0; waited < waitMs && (alive(tree.wrapper) || alive(tree.child)); waited += 100) await sleep(100);
  return [tree.wrapper, tree.child].filter(alive).length;
}

test('wrapper and browser MCP child end when the agent crashes', { timeout: 30000 }, async () => {
  const { tree, cleanup } = await startTree('plain');
  try {
    assert.equal([tree.parent, tree.wrapper, tree.child].filter(alive).length, 3);
    process.kill(tree.parent, 'SIGKILL');
    assert.equal(await count(tree, 5000), 0, 'no wrapper or child is left');
  } finally { cleanup(); }
});

test('wrapper and child end after the agent crashes while another process holds stdin open', { timeout: 30000 }, async () => {
  const { tree, cleanup } = await startTree('hold');
  try {
    assert.ok(tree.holder && alive(tree.holder));
    process.kill(tree.parent, 'SIGKILL');
    // stdin does not end here; the parent PID check runs every 2 s.
    assert.equal(await count(tree, 8000), 0, 'no wrapper or child is left');
    assert.ok(alive(tree.holder!), 'the process that held stdin was not touched');
  } finally { cleanup(); }
});

test('wrapper stays while its agent is alive and another process holds stdin open', { timeout: 30000 }, async () => {
  const { tree, cleanup } = await startTree('hold');
  try {
    await sleep(4500);
    assert.equal([tree.parent, tree.wrapper, tree.child].filter(alive).length, 3, 'a live agent keeps its browser MCP server');
  } finally { cleanup(); }
});
