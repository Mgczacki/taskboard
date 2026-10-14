import { spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after } from 'node:test';

// Each test file owns only the sockets and children it registers here.
export class TestResources {
  private readonly sockets = new Set<string>();
  private readonly children = new Set<ChildProcess>();
  private readonly directChildren = new Set<ChildProcess>();
  private readonly closedChildren = new WeakSet<ChildProcess>();
  private readonly chrome = new Map<number, string>();
  private readonly browserRoots = new Set<string>();
  private stopping?: Promise<void>;
  private stopped = false;

  constructor() {
    after(() => this.stop());
    process.once('exit', () => this.stopSync());
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        void this.stop().finally(() => process.exit(128 + (signal === 'SIGINT' ? 2 : 15)));
      });
    }
  }

  socket(name: string): string {
    if (!/^tb[a-z0-9-]+$/.test(name) || name === 'taskboard') throw new Error(`Unsafe test tmux socket: ${name}`);
    this.sockets.add(name);
    return name;
  }

  child<T extends ChildProcess>(child: T): T {
    this.children.add(child);
    child.once('close', () => this.closedChildren.add(child));
    return child;
  }

  directChild<T extends ChildProcess>(child: T): T {
    this.child(child);
    this.directChildren.add(child);
    return child;
  }

  private signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) return;
    try { process.kill(this.directChildren.has(child) ? child.pid : -child.pid, signal); } catch { /* exited */ }
  }

  async stopChild(child: ChildProcess): Promise<void> {
    if (!child.pid) return;
    const closed = this.closedChildren.has(child)
      ? Promise.resolve()
      : new Promise<void>(resolve => child.once('close', () => resolve()));
    this.signalChild(child, 'SIGTERM');
    let timer: NodeJS.Timeout | undefined;
    const ended = await Promise.race([
      closed.then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 3000); timer.unref(); }),
    ]);
    if (timer) clearTimeout(timer);
    if (!ended) {
      this.signalChild(child, 'SIGKILL');
      await Promise.race([closed, new Promise(resolve => { const t = setTimeout(resolve, 1000); t.unref(); })]);
    }
    this.children.delete(child);
    this.directChildren.delete(child);
  }

  // The profile path must be inside a test's private temporary folder.
  chromeProcess(pid: number, profile: string, root: string): void {
    if (!profile.startsWith(root + '/') || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('Unsafe test Chrome process');
    this.chrome.set(pid, profile);
  }

  browserRoot(root: string): void {
    const absolute = resolve(root);
    if (!absolute.startsWith(realpathSync(tmpdir()) + '/tb-')) throw new Error(`Unsafe test browser root: ${root}`);
    this.browserRoots.add(absolute);
    process.env.TEST_BROWSER_CHILDREN_FILE = join(absolute, 'browser-children.jsonl');
  }

  private discoverChrome(): void {
    for (const root of this.browserRoots) {
      const file = join(root, 'browser-children.jsonl');
      if (!existsSync(file)) continue;
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        try {
          const { pid, profile, event } = JSON.parse(line);
          if (event === 'exit') this.chrome.delete(pid);
          else this.chromeProcess(pid, profile, root);
        } catch { /* incomplete line */ }
      }
    }
  }

  private stopChromeSync(): number[] {
    this.discoverChrome();
    const pids = [...this.chrome.keys()];
    for (const [pid] of this.chrome) {
      try { process.kill(-pid, 'SIGCONT'); } catch { /* exited */ }
      try { process.kill(-pid, 'SIGTERM'); } catch { /* exited */ }
      this.chrome.delete(pid);
    }
    return pids;
  }

  private async stopChrome(): Promise<void> {
    const pids = this.stopChromeSync();
    const alive = (pid: number) => { try { process.kill(-pid, 0); return true; } catch { return false; } };
    const deadline = Date.now() + 2000;
    while (pids.some(alive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    for (const pid of pids) if (alive(pid)) try { process.kill(-pid, 'SIGKILL'); } catch { /* exited */ }
  }

  private stopSockets(): void {
    for (const socket of this.sockets) {
      spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore', timeout: 2000 });
    }
  }

  private stopSync(): void {
    if (this.stopped) return;
    this.stopChromeSync();
    for (const child of this.children) if (child.pid && child.exitCode === null && child.signalCode === null) {
      this.signalChild(child, 'SIGTERM');
    }
    this.stopSockets();
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      await this.stopChrome();
      await Promise.all([...this.children].map(child => this.stopChild(child)));
      this.stopSockets();
      this.stopped = true;
    })();
    return this.stopping;
  }
}
