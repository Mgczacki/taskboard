import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import * as store from './store.ts';

export interface Recovery {
  text: string;
  session: string;
  pane: string;
  keyAt: number;
  at: number;
  box?: string;
  confirmed?: boolean;
  reason: string;
  attempts: number;
  exhausted?: boolean;
  cleanupOnly?: boolean;
  attemptedAt?: number;
}
const path = (id: string) => join(store.taskDir(id), 'text-recovery.json');
export const active = new Set<string>();
export const known = new Set<string>();
export function read(id: string): Recovery | undefined {
  try { return JSON.parse(readFileSync(path(id), 'utf8')) as Recovery || undefined; } catch { return undefined; }
}
export function write(id: string, entry: Recovery | undefined) {
  const before = read(id);
  if (entry) known.add(id); else known.delete(id);
  mkdirSync(store.taskDir(id), { recursive: true });
  const file = path(id);
  writeFileSync(file + '.tmp', JSON.stringify(entry || null), { mode: 0o600 });
  renameSync(file + '.tmp', file);
  if (before?.reason !== entry?.reason || before?.confirmed !== entry?.confirmed) store.touch(id);
}
