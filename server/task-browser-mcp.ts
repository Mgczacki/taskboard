import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BrowserClickEvidence, clickEvidenceTools } from './browser-click-evidence.ts';

const [script, ...args] = process.argv.slice(2);
if (!script) throw new Error('Missing upstream browser MCP script.');
const client = new Client({ name: 'taskboard-browser-evidence', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: [script, ...args, '--experimentalStructuredContent'],
  env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
});
await client.connect(transport);
const evidence = new BrowserClickEvidence(async (name, arguments_) =>
  await client.callTool({ name, arguments: arguments_ }) as CallToolResult);
const server = new Server({ name: 'taskboard-browser', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const result = await client.listTools();
  return { ...result, tools: clickEvidenceTools(result.tools) };
});
// Serialize calls so a snapshot cannot change while a click checks its receipt.
let queue = Promise.resolve();
server.setRequestHandler(CallToolRequestSchema, request => {
  const result = queue.then(() => evidence.call(request.params.name, request.params.arguments || {}));
  queue = result.then(() => {}, () => {});
  return result;
});
const close = async () => { await client.close(); await server.close(); };
process.on('SIGTERM', () => { void close(); });
process.on('SIGINT', () => { void close(); });
server.onclose = () => { void client.close(); };
await server.connect(new StdioServerTransport());
