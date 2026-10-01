// Small file helpers for the messages module.
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Writes JSON to a private file (mode 0600) with an atomic rename.
export function savePrivate(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(data, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
}
export function readJson<T>(file: string, fallback: T): T {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback; } catch { return fallback; }
}
