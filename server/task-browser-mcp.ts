import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BrowserClickEvidence, clickEvidenceTools } from './browser-click-evidence.ts';

const PARENT_CHECK_MS = 2000;
const argv = process.argv.slice(2);
const evidenceEnabled = argv[0] === '--click-evidence';
const [script, ...args] = evidenceEnabled ? argv.slice(1) : argv;
if (!script) throw new Error('Missing upstream browser MCP script.');
const client = new Client({ name: 'taskboard-browser-evidence', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: [script, ...args, '--experimentalStructuredContent'],
  env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
});
const upstreamReady = client.connect(transport);
const evidence = evidenceEnabled ? new BrowserClickEvidence(async (name, arguments_) =>
  await client.callTool({ name, arguments: arguments_ }) as CallToolResult) : null;
const server = new Server({ name: 'taskboard-browser', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => {
  await upstreamReady;
  const result = await client.listTools();
  return { ...result, tools: evidence ? clickEvidenceTools(result.tools) : result.tools };
});
// Serialize calls so a snapshot cannot change while a click checks its receipt.
let queue = Promise.resolve();
server.setRequestHandler(CallToolRequestSchema, request => {
  const result = queue.then(async () => {
    await upstreamReady;
    return evidence
      ? evidence.call(request.params.name, request.params.arguments || {})
      : client.callTool({ name: request.params.name, arguments: request.params.arguments || {} }) as Promise<CallToolResult>;
  });
  queue = result.then(() => {}, () => {});
  return result;
});
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  if (transport.pid) {
    try { process.kill(transport.pid, 'SIGTERM'); } catch { /* child already exited */ }
  }
  try { await client.close(); } catch { /* child already exited */ }
  try { await server.close(); } finally { process.exit(0); }
};
process.stdin.once('end', () => { void close(); });
process.stdin.once('close', () => { void close(); });
// Another process can still hold the write end of stdin after the agent dies, so stdin does not end. The parent PID
// changes when the agent dies (the system gives the wrapper a new parent), and a dead parent's PID never comes back here.
const parent = process.ppid;
if (parent > 1) setInterval(() => { if (process.ppid !== parent) void close(); }, PARENT_CHECK_MS).unref();
process.on('SIGTERM', () => { void close(); });
process.on('SIGINT', () => { void close(); });
server.onclose = () => { void close(); };
client.onclose = () => { void close(); };
await server.connect(new StdioServerTransport());
await upstreamReady;
