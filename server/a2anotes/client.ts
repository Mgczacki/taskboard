// Taskboard's connection to the A2A Notes service. Taskboard is an ordinary MCP client of that service, with one client
// token for each role. The dashboard uses the person token, the controller
// uses the reviewer token, and tasks use the agent token. The service checks each role itself.
// The settings file is TB_DIR/a2anotes.json (private): { "enabled": true, "url": "http://127.0.0.1:4460/mcp",
// "tokens": { "person": "a2an_…", "reviewer": "a2an_…", "agent": "a2an_…" } }. It is off when the file is missing.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TB_DIR } from '../config.ts';

export type Role = 'person' | 'reviewer' | 'agent';
export interface Settings { enabled: boolean; url: string; tokens: Partial<Record<Role, string>> }

export function readSettings(file = join(TB_DIR, 'a2anotes.json')): Settings {
  if (!existsSync(file)) return { enabled: false, url: '', tokens: {} };
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const url = typeof raw.url === 'string' ? raw.url : '';
  // loopback only: the tokens must not leave this computer without TLS
  if (url && !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/mcp$/.test(url)) throw new Error('a2anotes.json url must be a loopback MCP endpoint, for example http://127.0.0.1:4460/mcp');
  return { enabled: raw.enabled === true && !!url, url, tokens: raw.tokens && typeof raw.tokens === 'object' ? raw.tokens : {} };
}

// An error that the service returned: a stable code, a plain reason, and the next action.
export class A2AError extends Error {
  constructor(readonly code: string, message: string, readonly next = '') { super(message); }
}

export class A2ANotesClient {
  private clients = new Map<Role, Promise<Client>>();
  constructor(readonly settings: Settings) {}

  private connect(role: Role) {
    const token = this.settings.tokens[role];
    if (!token) throw new A2AError('not_configured', `a2anotes.json has no ${role} token.`, `Run a2a-notes token add taskboard-${role} --role ${role} and add the token.`);
    let client = this.clients.get(role);
    if (!client) {
      client = (async () => {
        const c = new Client({ name: `taskboard-${role}`, version: '1' });
        await c.connect(new StreamableHTTPClientTransport(new URL(this.settings.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
        return c;
      })();
      client.catch(() => this.clients.delete(role));
      this.clients.set(role, client);
    }
    return client;
  }

  // Calls one tool. A connection failure drops the client, so the next call connects again.
  async call<T = any>(role: Role, tool: string, args: Record<string, unknown> = {}): Promise<T> {
    let result: any;
    // a scan can run the model checks on several messages: allow five minutes, not the SDK default of one minute
    try { result = await (await this.connect(role)).callTool({ name: tool, arguments: args }, undefined, { timeout: 300_000 }); }
    catch (error) {
      if (error instanceof A2AError) throw error;
      this.clients.delete(role);
      throw new A2AError('service_unavailable', 'The A2A Notes service is not reachable.', 'Start it from the Settings page, under Integrations.');
    }
    if (result.isError) {
      const e = result.structuredContent?.error;
      throw new A2AError(e?.code || 'error', e?.reason || result.content?.[0]?.text || 'The A2A Notes service refused the request.', e?.next || '');
    }
    return result.structuredContent as T;
  }

  // Reads a JSON resource, for example a2anotes://policy.
  async resource<T = any>(role: Role, uri: string): Promise<T> {
    try {
      const result = await (await this.connect(role)).readResource({ uri });
      const first = result.contents[0] as { text?: string } | undefined;
      return JSON.parse(first?.text || 'null');
    } catch (error) {
      if (error instanceof A2AError) throw error;
      this.clients.delete(role);
      throw new A2AError('service_unavailable', 'The A2A Notes service is not reachable.', 'Start it from the Settings page, under Integrations.');
    }
  }

  async close() {
    for (const client of this.clients.values()) { try { await (await client).close(); } catch { /* already closed */ } }
    this.clients.clear();
  }
}
