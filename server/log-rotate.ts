// Rotation of the server log. launchd opens <TB_DIR>/server.log for stdout and stderr (scripts/install-launchd.sh) and
// never rotates it: on 2026-10-02 it had 178,923 lines (5 MB), 98% of them from one loop of failed terminal attaches.
// The server cannot reopen the file that launchd gave it, so it rotates by copy and truncate: it copies the file to
// server.log.1 (and moves older copies to .2 and .3), then truncates server.log to 0 bytes. launchd opened the file
// with O_APPEND (lsof shows the flag AP), so the next write goes to the new end of the file, not to the old offset.
// It rotates only when stdout is that file (same device and inode), so a server started in a terminal, a sandbox or
// a test leaves other files alone.
import { copyFileSync, existsSync, fstatSync, renameSync, statSync, truncateSync } from 'node:fs';

export const MAX_BYTES = 20 * 1024 * 1024;
export const KEEP = 3;

export function stdoutIs(file: string, fd = 1): boolean {
  try { const a = fstatSync(fd), b = statSync(file); return a.dev === b.dev && a.ino === b.ino; } catch { return false; }
}

// Returns true when it rotated.
export function rotateIfLarge(file: string, maxBytes = MAX_BYTES, keep = KEEP, fd = 1): boolean {
  if (!stdoutIs(file, fd)) return false;
  let size = 0; try { size = statSync(file).size; } catch { return false; }
  if (size < maxBytes) return false;
  try {
    for (let i = keep - 1; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    copyFileSync(file, `${file}.1`);
    truncateSync(file, 0);
    console.log(`${new Date().toISOString()} log rotated: the previous ${(size / 1048576).toFixed(1)} MB are in ${file}.1 (up to ${keep} old files are kept)`);
    return true;
  } catch (e) {
    console.error(`${new Date().toISOString()} log rotation failed: ${(e as Error).message}`);
    return false;
  }
}

// At start, then once an hour.
export function startRotation(file: string) {
  rotateIfLarge(file);
  setInterval(() => rotateIfLarge(file), 3600_000).unref();
}
