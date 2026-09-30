import { closeSync, existsSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';

const MAX_BYTES = 10 * 1024 * 1024;
const KEEP_BYTES = 5 * 1024 * 1024;

export function trimTerminalLog(path: string) {
  if (!existsSync(path) || statSync(path).size <= MAX_BYTES) return false;
  const fd = openSync(path, 'r');
  const tail = Buffer.alloc(KEEP_BYTES);
  try {
    const start = statSync(path).size - KEEP_BYTES;
    let length = 0;
    while (length < KEEP_BYTES) {
      const n = readSync(fd, tail, length, KEEP_BYTES - length, start + length);
      if (!n) break;
      length += n;
    }
    writeFileSync(path, Buffer.concat([Buffer.from('[Earlier terminal output removed.]\n'), tail.subarray(0, length)]));
  }
  finally { closeSync(fd); }
  return true;
}
