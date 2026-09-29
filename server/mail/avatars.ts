// Slack profile pictures and names for the Graph. The browser never loads a Slack URL: the server asks Slack
// users.info (scope users:read) for the picture URL, downloads the picture without the Slack token, and keeps it in
// TB_DIR/avatars/<user>.img. index.json there records the name, the content type and when the entry was fetched.
// A picture is fetched again after a week. A failed lookup is tried again after an hour.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { savePrivate } from './store.ts';
import type { SlackClient } from './slack.ts';

const FRESH = 7 * 24 * 3600_000, RETRY = 3600_000, MAX_BYTES = 256 * 1024;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
interface Entry { name?: string; type?: string; at: number; failed?: boolean }
export const isSlackUser = (id: string) => /^[UW][A-Z0-9]{1,20}$/.test(id);

// Slack serves profile pictures from its CDN, or from Gravatar for people without an uploaded picture.
export function allowedImageUrl(url: string) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname.endsWith('.slack-edge.com') || u.hostname === 'secure.gravatar.com');
  } catch { return false; }
}

export class Avatars {
  private loading = new Map<string, Promise<void>>();
  constructor(readonly dir: string, readonly slack: SlackClient, private fetcher: typeof fetch = fetch) {}
  private index(): Record<string, Entry> {
    try { return JSON.parse(readFileSync(join(this.dir, 'index.json'), 'utf8')); } catch { return {}; }
  }
  name(user: string) { return this.index()[user]?.name; }
  // The picture of one person, or undefined when there is none. Fetches from Slack when the stored entry is old.
  async picture(user: string): Promise<{ path: string; type: string } | undefined> {
    if (!isSlackUser(user)) return undefined;
    let entry = this.index()[user];
    if (!entry || Date.now() - entry.at > (entry.failed ? RETRY : FRESH)) {
      await this.refresh(user);
      entry = this.index()[user];
    }
    const path = join(this.dir, `${user}.img`);
    return entry?.type && existsSync(path) ? { path, type: entry.type } : undefined;
  }
  // Starts a fetch for a person with no entry yet, so the Graph gets the name on its next load.
  warm(user: string) { if (isSlackUser(user) && !this.index()[user]) void this.picture(user).catch(() => {}); }
  private refresh(user: string) {
    let p = this.loading.get(user);
    if (!p) {
      p = this.fetchEntry(user).finally(() => this.loading.delete(user));
      this.loading.set(user, p);
    }
    return p;
  }
  private async fetchEntry(user: string) {
    if (!this.slack.identity()) return; // not connected: no entry, so the next request tries again
    const old = this.index()[user];
    let entry: Entry = { name: old?.name, type: old?.type, at: Date.now(), failed: true };
    try {
      const info = await this.slack.call('users.info', { user });
      const p = info.user?.profile || {};
      const name = String(p.display_name || info.user?.real_name || p.real_name || info.user?.name || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100);
      entry = { ...entry, name: name || old?.name };
      const url = String(p.image_72 || p.image_48 || '');
      if (allowedImageUrl(url)) {
        const res = await this.fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
        const type = String(res.headers.get('content-type') || '').split(';')[0].trim();
        if (res.ok && TYPES.has(type) && Number(res.headers.get('content-length') || 0) <= MAX_BYTES) {
          const bytes = Buffer.from(await res.arrayBuffer());
          if (bytes.length <= MAX_BYTES) {
            mkdirSync(this.dir, { recursive: true, mode: 0o700 });
            writeFileSync(join(this.dir, `${user}.img`), bytes, { mode: 0o600 });
            entry = { name: entry.name, type, at: Date.now() };
          }
        }
      }
    } catch { /* keep the failed entry: the Graph shows initials and asks again after RETRY */ }
    const index = this.index(); index[user] = entry;
    savePrivate(join(this.dir, 'index.json'), index);
  }
}
