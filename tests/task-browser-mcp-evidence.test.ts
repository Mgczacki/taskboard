import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const NODE = ['/opt/homebrew/opt/node@22/bin/node', process.execPath].find(existsSync)!;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('stdio wrapper exposes reviewed click evidence and forwards the ordinary click', { timeout: 20000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-mcp-evidence-')));
  const sdk = (file: string) => pathToFileURL(resolve('node_modules/@modelcontextprotocol/sdk/dist/esm', file)).href;
  const fixture = join(root, 'upstream.mjs');
  writeFileSync(fixture, `
import { Server } from ${JSON.stringify(sdk('server/index.js'))};
import { StdioServerTransport } from ${JSON.stringify(sdk('server/stdio.js'))};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(sdk('types.js'))};
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.TB_UPSTREAM_PID_FILE, String(process.pid));
const server = new Server({name:'fixture',version:'1'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:[
 {name:'click', description:'Click', inputSchema:{type:'object',properties:{pageId:{type:'integer'},uid:{type:'string'}},required:['uid']}},
 {name:'take_snapshot', inputSchema:{type:'object',properties:{pageId:{type:'integer'}}}}
]}));
server.setRequestHandler(CallToolRequestSchema, async ({params}) => {
 if (params.name === 'list_pages') return {content:[],structuredContent:{pages:[{id:32,url:'https://example.test/',selected:true}]}};
 if (params.name === 'take_snapshot') return {content:[],structuredContent:{snapshot:{id:'5_0',role:'RootWebArea',children:[{id:'5_54',role:'button',name:'Route permissions'}]}}};
 if (params.name === 'evaluate_script') return {content:[{type:'text',text:'Script ran on page and returned:\\n\x60\x60\x60json\\n{"visible":true,"url":"https://example.test/"}\\n\x60\x60\x60'}]};
 return {content:[{type:'text',text:JSON.stringify(params)}]};
});

await server.connect(new StdioServerTransport());
`);
  const client = new Client({ name: 'test', version: '1' });
  const transport = new StdioClientTransport({ command: NODE,
    args: ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('server/task-browser-mcp.ts'), '--click-evidence', fixture],
    stderr: 'pipe',
    env: { TB_UPSTREAM_PID_FILE: join(root, 'upstream.pid') },
  });
  let stderr = '';
  transport.stderr?.on('data', data => { stderr += data.toString(); });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert.ok(tools.find(tool => tool.name === 'click')?.inputSchema.required?.includes('target'));
    assert.ok(tools.find(tool => tool.name === 'prepare_click'));
    await client.callTool({ name: 'take_snapshot', arguments: { pageId: 32 } });
    const prepared = await client.callTool({ name: 'prepare_click', arguments: { pageId: 32, uid: '5_54' } });
    assert.ok(!prepared.isError, JSON.stringify(prepared) + stderr);
    const target = prepared.structuredContent!.target;
    const clicked = await client.callTool({ name: 'click', arguments: { pageId: 32, uid: '5_54', target } });
    assert.ok(!clicked.isError, JSON.stringify(clicked) + stderr);
    assert.deepEqual(JSON.parse((clicked.content as { text: string }[])[0].text), {
      name: 'click', arguments: { pageId: 32, uid: '5_54' },
    });
    const again = await client.callTool({ name: 'click', arguments: { pageId: 32, uid: '5_54', target } });
    assert.equal(again.isError, true);
  } catch (error) {
    throw new Error(`${String(error)}\n${stderr}`);
  } finally {
    const wrapperPid = transport.pid;
    const childPid = Number(readFileSync(join(root, 'upstream.pid'), 'utf8'));
    await client.close();
    for (let i = 0; i < 30 && (alive(wrapperPid || 0) || alive(childPid)); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(alive(wrapperPid || 0), false, 'the wrapper exits with the MCP connection');
    assert.equal(alive(childPid), false, 'the browser MCP child exits with the wrapper');
    rmSync(root, { recursive: true, force: true });
  }
});

test('wrapper handshakes with the installed browser MCP without starting Chrome', { timeout: 20000 }, async () => {
  const client = new Client({ name: 'test', version: '1' });
  const transport = new StdioClientTransport({ command: NODE,
    args: ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('server/task-browser-mcp.ts'), '--click-evidence',
      resolve('node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'),
      '--wsEndpoint', 'ws://127.0.0.1:1', '--no-usage-statistics', '--no-performance-crux'],
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    const click = tools.find(tool => tool.name === 'click');
    assert.ok(click?.inputSchema.required?.includes('target'));
    assert.ok(tools.find(tool => tool.name === 'prepare_click'));
    assert.ok(tools.find(tool => tool.name === 'take_snapshot')?.inputSchema.properties?.pageId);
  } finally { await client.close(); }
});

test('Claude wrapper passes through the installed browser tools', { timeout: 20000 }, async () => {
  const client = new Client({ name: 'test', version: '1' });
  const transport = new StdioClientTransport({ command: NODE,
    args: ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('server/task-browser-mcp.ts'),
      resolve('node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'),
      '--wsEndpoint', 'ws://127.0.0.1:1', '--no-usage-statistics', '--no-performance-crux'],
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert.ok(tools.find(tool => tool.name === 'click'));
    assert.equal(tools.some(tool => tool.name === 'prepare_click'), false);
  } finally { await client.close(); }
});
