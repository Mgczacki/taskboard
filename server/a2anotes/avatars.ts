// Profile pictures and names for the dashboard. The browser never loads a Slack URL: the server asks A2A Notes for the
// person (a2anotes_get_person), downloads the picture, and keeps it in TB_DIR/avatars/<member>.img. index.json there
// records the name, the content type, and when the entry was fetched. A picture is fetched again after a week; a
// failed lookup is tried again after an hour.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { savePrivate } from './files.ts';

const FRESH = 7 * 24 * 3600_000, RETRY = 3600_000, MAX_BYTES = 256 * 1024;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
interface Entry { name?: string; type?: string; at: number; failed?: boolean }
export const isSlackUser = (id: string) => /^[UW][A-Z0-9]{1,20}$/.test(id);
export type PersonLookup = (user: string) => Promise<{ name?: string; image?: string } | undefined>;

// Slack serves profile pictures from its CDN, or from Gravatar for people without an uploaded picture.
export function allowedImageUrl(url: string) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname.endsWith('.slack-edge.com') || u.hostname === 'secure.gravatar.com');
  } catch { return false; }
}

export class Avatars {
  private loading = new Map<string, Promise<void>>();
  constructor(readonly dir: string, private lookup: PersonLookup, private fetcher: typeof fetch = fetch) {}
  private index(): Record<string, Entry> {
    try { return JSON.parse(readFileSync(join(this.dir, 'index.json'), 'utf8')); } catch { return {}; }
  }
  name(user: string) { return this.index()[user]?.name; }
  async picture(user: string): Promise<{ path: string; type: string } | undefined> {
    if (!isSlackUser(user)) return undefined;
    let entry = this.index()[user];
    if (!entry || Date.now() - entry.at > (entry.failed ? RETRY : FRESH)) { await this.refresh(user); entry = this.index()[user]; }
    const path = join(this.dir, `${user}.img`);
    return entry?.type && existsSync(path) ? { path, type: entry.type } : undefined;
  }
  // Starts a fetch for a person with no entry yet, so the next page load has the name.
  warm(user: string) { if (isSlackUser(user) && !this.index()[user]) void this.picture(user).catch(() => {}); }
  private refresh(user: string) {
    let p = this.loading.get(user);
    if (!p) { p = this.fetchEntry(user).finally(() => this.loading.delete(user)); this.loading.set(user, p); }
    return p;
  }
  private async fetchEntry(user: string) {
    const old = this.index()[user];
    let entry: Entry = { name: old?.name, type: old?.type, at: Date.now(), failed: true };
    try {
      const person = await this.lookup(user);
      if (!person) return; // A2A Notes is off or not connected: no entry, so the next request tries again
      const name = String(person.name || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100);
      entry = { ...entry, name: name || old?.name };
      const url = String(person.image || '');
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
    } catch { /* keep the failed entry: the page shows initials and asks again after RETRY */ }
    const index = this.index(); index[user] = entry;
    savePrivate(join(this.dir, 'index.json'), index);
  }
}
