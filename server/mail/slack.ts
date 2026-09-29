import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { savePrivate } from './store.ts';

export const SLACK_APP_ID = 'A0C57MV7K6V';
export const SLACK_CLIENT_ID = '8696283833057.12177743257233';
export const SLACK_TEAM_ID = 'T08LG8BQH1P';
export const SLACK_SCOPES = ['chat:write', 'im:write', 'im:read', 'im:history', 'users:read', 'users:read.email', 'files:write', 'files:read'];
interface Credentials { user: string; team: string; name?: string; scopes?: string[]; access: string; refresh: string; expires: number }
export class SlackError extends Error {
  constructor(message: string, readonly retryAfter = 0) { super(message); }
}
export class SlackClient {
  private generation = 0;
  private refreshing?: Promise<void>;
  private blockedUntil = 0;
  private pending?: { state: string; verifier: string; redirect: string; expires: number };
  constructor(readonly file: string, private fetcher: typeof fetch = fetch) {}
  private credentials(): Credentials | undefined { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : undefined; }
  identity() { const c = this.credentials(); return c ? { user: c.user, team: c.team, name: c.name, scopes: c.scopes, needsReconnect: !c.scopes || SLACK_SCOPES.some(s => !c.scopes?.includes(s)) } : null; }
  disconnect() { this.generation++; this.pending = undefined; if (existsSync(this.file)) unlinkSync(this.file); }
  begin(port: number) {
    if (![4317, 4399, 4409, 4410].includes(port)) throw new Error('Slack sign-in requires port 4317 or a registered test port');
    const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
    const redirect = `http://localhost:${port}/api/mail/slack/callback`;
    this.pending = { verifier, state, redirect, expires: Date.now() + 10 * 60_000 };
    const params = new URLSearchParams({ client_id: SLACK_CLIENT_ID, user_scope: SLACK_SCOPES.join(','), team: SLACK_TEAM_ID, state, redirect_uri: redirect, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    return `https://slack.com/oauth/v2/authorize?${params}`;
  }
  private async request(method: string, params: Record<string, string>, token?: string): Promise<any> {
    if (Date.now() < this.blockedUntil) throw new SlackError('Slack rate limit. Try again later.', Math.ceil((this.blockedUntil - Date.now()) / 1000));
    const res = await this.fetcher(`https://slack.com/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: new URLSearchParams(params), signal: AbortSignal.timeout(20_000) });
    if (res.status === 429) { const retry = Math.max(1, Number(res.headers.get('retry-after')) || 60); this.blockedUntil = Date.now() + retry * 1000; throw new SlackError('Slack rate limit. Try again later.', retry); }
    if (!res.ok) throw new SlackError(`Slack returned HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new SlackError(`Slack: ${String(data.error || 'request failed').replace(/[^a-z_]/g, '').slice(0, 80)}`);
    return data;
  }
  async finish(state: string, code: string) {
    const generation = this.generation;
    const p = this.pending;
    if (!p || p.expires < Date.now() || state !== p.state) throw new Error('Sign-in expired or did not start on this Taskboard');
    this.pending = undefined;
    const result = await this.request('oauth.v2.access', { client_id: SLACK_CLIENT_ID, code, code_verifier: p.verifier, redirect_uri: p.redirect });
    const c = result.authed_user;
    if (result.team?.id !== SLACK_TEAM_ID || !c?.id || !c.access_token || !c.refresh_token) throw new Error('Slack did not return the expected user authorization');
    const scopes = new Set(String(c.scope || '').split(','));
    if (SLACK_SCOPES.some(s => !scopes.has(s))) throw new Error('Slack did not grant all required permissions');
    let name = c.real_name || c.name || c.id;
    try {
      const info = await this.request('users.info', { user: c.id }, c.access_token);
      name = info.user?.profile?.real_name || info.user?.real_name || info.user?.profile?.display_name || info.user?.name || name;
    } catch { /* Slack sign-in still provides the member ID when profile lookup fails. */ }
    const previous = this.identity();
    if (previous && previous.user !== c.id) throw new Error('Disconnect the current user before connecting a different user');
    if (generation !== this.generation) throw new Error('Sign-in was cancelled');
    savePrivate(this.file, { user: c.id, team: result.team.id, name, scopes: [...scopes], access: c.access_token, refresh: c.refresh_token, expires: Date.now() + Number(c.expires_in || 43200) * 1000 });
  }
  async call(method: string, params: Record<string, string> = {}) {
    const generation = this.generation;
    let c = this.credentials(); if (!c) throw new Error('Connect Slack first');
    if (c.expires < Date.now() + 120_000) {
      if (!this.refreshing) this.refreshing = this.request('oauth.v2.access', { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: SLACK_CLIENT_ID }).then(result => {
        const token = result.authed_user || result;
        if (!token.access_token || !token.refresh_token) throw new Error('Reconnect Slack to renew access');
        if (generation !== this.generation) throw new Error('Slack was disconnected');
        savePrivate(this.file, { ...c, access: token.access_token, refresh: token.refresh_token, expires: Date.now() + Number(token.expires_in || 43200) * 1000 });
      }).finally(() => { this.refreshing = undefined; });
      await this.refreshing; c = this.credentials()!;
    }
    if (!c || generation !== this.generation) throw new Error('Slack was disconnected');
    return this.request(method, params, c.access);
  }
  async upload(name: string, bytes: Buffer, channel: string) {
    const ticket = await this.call('files.getUploadURLExternal', { filename: name, length: String(bytes.length) });
    const target = new URL(String(ticket.upload_url || ''));
    if (target.protocol !== 'https:' || !target.hostname.endsWith('.slack.com')) throw new Error('Slack returned an invalid upload URL');
    const response = await this.fetcher(target, { method: 'POST', body: new Uint8Array(bytes), signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error('Slack did not accept the file bytes');
    await this.call('files.completeUploadExternal', { files: JSON.stringify([{ id: ticket.file_id, title: name }]), channel_id: channel });
    return String(ticket.file_id);
  }
  async download(id: string, channel: string, sender: string, maxBytes: number) {
    const info = await this.call('files.info', { file: id });
    const file = info.file;
    if (!file || file.user !== sender || file.size > maxBytes || file.size < 1 || file.is_external) throw new Error('Slack file metadata is not allowed');
    const shares = file.shares?.private?.[channel] || file.shares?.im?.[channel];
    if (!shares && !(file.ims || []).includes(channel)) throw new Error('The file is not shared in this conversation');
    const target = new URL(String(file.url_private || ''));
    if (target.protocol !== 'https:' || !target.hostname.endsWith('.slack.com')) throw new Error('Slack returned an invalid file URL');
    await this.call('auth.test');
    const token = this.credentials()?.access; if (!token) throw new Error('Connect Slack first');
    const response = await this.fetcher(target, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error('Slack file download failed');
    const chunks: Uint8Array[] = []; let count = 0;
    if (!response.body) throw new Error('Slack returned an empty file response');
    for await (const chunk of response.body) { count += chunk.length; if (count > maxBytes) throw new Error('Slack file exceeds the Taskboard limit'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
}
