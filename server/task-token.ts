import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TB_DIR } from './config.ts';

const file = join(TB_DIR, 'task-tokens.json');
const dir = join(TB_DIR, 'task-tokens');
const tokens: Record<string, string> = (() => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
})();

export function forTask(id: string): string {
  if (!tokens[id]) {
    tokens[id] = randomBytes(32).toString('hex');
    writeFileSync(file, JSON.stringify(tokens), { mode: 0o600 });
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, id), tokens[id], { mode: 0o600 });
  return tokens[id];
}

export const fileFor = (id: string) => { forTask(id); return join(dir, id); };

export function actorFor(token: string | undefined): string | undefined {
  if (!token) return;
  return Object.keys(tokens).find(id => tokens[id] === token);
}
