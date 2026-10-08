import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TB_DIR } from './config.ts';

export type Kind = 'message' | 'document' | 'read';
export const LIMIT_PER_HOUR = 30;
const FILE = join(TB_DIR, 'all-task-communication.jsonl');

function rows(): { at: string; from: string; to: string; kind: Kind; event: string }[] {
  try { return readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch { return []; }
}

export function limited(from: string, to: string, kind: Kind): boolean {
  const since = Date.now() - 3_600_000;
  return rows().filter(row => row.event === 'claimed' && row.from === from && row.to === to && row.kind === kind && Date.parse(row.at) > since).length >= LIMIT_PER_HOUR;
}

export function claim(from: string, to: string, kind: Kind): boolean {
  if (limited(from, to, kind)) return false;
  appendFileSync(FILE, JSON.stringify({ at: new Date().toISOString(), event: 'claimed', from, to, kind }) + '\n', { mode: 0o600 });
  return true;
}

export function record(from: string, to: string, kind: Kind, detail: string, state: string) {
  appendFileSync(FILE, JSON.stringify({ at: new Date().toISOString(), event: 'delivered', from, to, kind, detail, state }) + '\n', { mode: 0o600 });
}
