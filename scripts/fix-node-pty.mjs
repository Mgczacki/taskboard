// node-pty ships its macOS spawn-helper without the execute bit when installed by pnpm.
// Without it every pty spawn fails with "posix_spawnp failed". Runs after each install.
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = dirname(require.resolve('node-pty/package.json'));
const dir = join(root, 'prebuilds');
if (existsSync(dir)) {
  for (const arch of readdirSync(dir)) {
    const helper = join(dir, arch, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}
