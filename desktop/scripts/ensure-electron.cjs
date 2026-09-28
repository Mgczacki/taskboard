// Make sure the Electron binary is in node_modules/electron/dist. Electron's own download script (run by
// `pnpm install`) needs Node 22.12 or newer; on older Node it fails without saying so. In that case this script does
// the same job: download the official build from Electron's GitHub releases, check it against the published
// SHA-256 sums, and unpack it.
const { execFileSync } = require('node:child_process');
const { existsSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');

const pkgDir = dirname(require.resolve('electron/package.json'));
if (existsSync(join(pkgDir, 'dist', 'Electron.app')) && existsSync(join(pkgDir, 'path.txt'))) process.exit(0);

const version = require(join(pkgDir, 'package.json')).version;
const file = `electron-v${version}-darwin-${process.arch}.zip`;
const base = `https://github.com/electron/electron/releases/download/v${version}`;
const tmp = mkdtempSync(join(tmpdir(), 'electron-'));
console.log(`Downloading ${file}…`);
execFileSync('curl', ['-fsSL', '-o', join(tmp, file), `${base}/${file}`], { stdio: 'inherit' });
execFileSync('curl', ['-fsSL', '-o', join(tmp, 'SHASUMS256.txt'), `${base}/SHASUMS256.txt`], { stdio: 'inherit' });
const sums = require('node:fs').readFileSync(join(tmp, 'SHASUMS256.txt'), 'utf8').split('\n');
const want = (sums.find(l => l.trim().endsWith(file)) || '').split(/\s+/)[0];
const got = execFileSync('shasum', ['-a', '256', join(tmp, file)], { encoding: 'utf8' }).split(/\s+/)[0];
if (!want || want !== got) { console.error(`Checksum mismatch for ${file} (expected ${want || 'none listed'}, got ${got}). Not installing it.`); process.exit(1); }
rmSync(join(pkgDir, 'dist'), { recursive: true, force: true });
execFileSync('ditto', ['-x', '-k', join(tmp, file), join(pkgDir, 'dist')]);
writeFileSync(join(pkgDir, 'path.txt'), 'Electron.app/Contents/MacOS/Electron');
rmSync(tmp, { recursive: true, force: true });
console.log(`Electron ${version} installed (checksum verified).`);
