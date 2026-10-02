// pty.spawn without the descriptor that node-pty 1.1.0 leaks on macOS.
// Its pty_posix_spawn (src/unix/pty.cc) opens one to three extra /dev/ptmx descriptors, so that the terminal does not
// get descriptor 0, 1 or 2, and then closes low_fds[1..count] but not low_fds[0]. In a server, where 0-2 are open, that
// is one pseudo-terminal for each spawn. Taskboard spawns one `tmux attach` for each browser terminal that opens, and
// macOS has a fixed number of pseudo-terminals (kern.tty.ptmx_max, 511 on the Mac where this was found). The running
// server had 302 of them after two hours; at the limit, pty.spawn throws. node-pty 1.2.0 (beta) closes low_fds[0].
// So after each spawn, the descriptors that the spawn opened, other than the terminal's own, are closed when they are
// pseudo-terminal masters like it (same device major number). No other descriptor can match.
import { closeSync, fstatSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as pty from 'node-pty';

const version = (createRequire(import.meta.url)('node-pty/package.json') as { version: string }).version;
export const leaksDescriptor = process.platform === 'darwin' && version === '1.1.0';
// the listing shows the descriptor that reads /dev/fd itself, which is closed again at once; the spawn can reuse its number
const isOpen = (fd: number) => { try { fstatSync(fd); return true; } catch { return false; } };
const openDescriptors = () => new Set(readdirSync('/dev/fd').map(Number).filter(isOpen));
// macOS dev_t: the major number is the top 8 bits
const major = (rdev: number) => (rdev >>> 24) & 0xff;

export function spawnPty(file: string, args: string[], options: pty.IPtyForkOptions): pty.IPty {
  const before = leaksDescriptor ? openDescriptors() : null;
  const p = pty.spawn(file, args, options);
  if (before) {
    const own = (p as unknown as { _fd: number })._fd;
    const kind = major(fstatSync(own).rdev);
    for (const fd of openDescriptors()) {
      if (before.has(fd) || fd === own) continue;
      try {
        const s = fstatSync(fd);
        if (s.isCharacterDevice() && major(s.rdev) === kind) closeSync(fd);
      } catch { /* the descriptor of the /dev/fd listing, closed again */ }
    }
  }
  return p;
}
