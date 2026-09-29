import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, extname, join, sep } from 'node:path';
import { TB_DIR } from '../config.ts';
import type { MailFile } from './store.ts';

export const MAX_FILE = 10 * 1024 * 1024;
const allowed = new Set(['.txt', '.md', '.pdf', '.docx']);
const root = join(TB_DIR, 'mail-files');
export function publicFile(file: MailFile) {
  const { path: _path, ...shown } = file;
  return shown;
}
export function checkName(name: string) {
  if (!name || name !== basename(name) || /[\x00-\x1f\x7f]/.test(name) || !allowed.has(extname(name).toLowerCase())) throw new Error('Choose a TXT, MD, PDF, or DOCX file');
  return name;
}
function fileFromBytes(bytes: Buffer, name: string, direction: 'incoming' | 'outgoing', expectedHash?: string): MailFile {
  if (!name || name !== basename(name) || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Invalid file name');
  if (direction === 'outgoing') checkName(name);
  if (!bytes.length || bytes.length > MAX_FILE) throw new Error('File must be between 1 byte and 10 MiB');
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (expectedHash && hash !== expectedHash) throw new Error('File hash does not match the message');
  const id = randomUUID(), dir = join(root, direction);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, id);
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  return { id, name, size: bytes.length, hash, path };
}
export function stageBytes(bytes: Buffer, name: string) { return fileFromBytes(bytes, name, 'outgoing'); }
export function receiveBytes(bytes: Buffer, name: string, hash: string) { return fileFromBytes(bytes, name, 'incoming', hash); }
export function stagePath(path: string, outbox: string) {
  const file = realpathSync(path), folder = realpathSync(outbox);
  if (!file.startsWith(folder + sep) || lstatSync(path).isSymbolicLink() || !lstatSync(file).isFile()) throw new Error('Choose a regular file from the task outbox');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('Choose a regular file under 10 MiB');
    return stageBytes(readFileSync(fd), basename(file));
  } finally { closeSync(fd); }
}
export function verifyFile(file: MailFile) {
  if (!existsSync(file.path) || lstatSync(file.path).isSymbolicLink()) throw new Error('File is missing');
  const bytes = readFileSync(file.path);
  if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.hash) throw new Error('File changed after approval');
  return bytes;
}
export function extractText(file: MailFile): string {
  const bytes = verifyFile(file);
  const type = extname(file.name).toLowerCase();
  if (type === '.txt' || type === '.md') {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error('File contains control characters');
    return text;
  }
  if (type === '.pdf') {
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('PDF signature does not match');
    return execFileSync('pdftotext', ['-f', '1', '-l', '100', file.path, '-'], { timeout: 10000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
  }
  if (type !== '.docx') throw new Error('File type is not supported');
  if (bytes.subarray(0, 2).toString() !== 'PK') throw new Error('DOCX signature does not match');
  const names = execFileSync('unzip', ['-Z1', file.path], { timeout: 10000, maxBuffer: 64 * 1024, encoding: 'utf8' });
  if (/vbaProject|embeddings\/|activeX\/|externalLinks\//i.test(names) || !names.split('\n').includes('word/document.xml')) throw new Error('DOCX contains unsupported content');
  const xml = execFileSync('unzip', ['-p', file.path, 'word/document.xml'], { timeout: 10000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
  return xml.replace(/<w:p\b[^>]*>/g, '\n').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
export function routeFile(file: MailFile, destination: string) {
  const bytes = verifyFile(file);
  mkdirSync(destination, { recursive: true });
  const target = join(destination, `mail-${file.id}-${file.name}`);
  if (existsSync(target)) {
    const current = readFileSync(target);
    if (!current.equals(bytes)) throw new Error('The task file changed');
  } else {
    const temp = join(destination, `.mail-${randomUUID()}`);
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
    renameSync(temp, target);
  }
  return target;
}
