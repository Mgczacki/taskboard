// Copy the built app to ~/Applications (no admin rights needed), replacing an older copy. If the app is running,
// it is asked to quit first; the Taskboard server and agents are not affected.
const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, rmSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

const built = join(__dirname, '..', 'out', 'Taskboard-darwin-arm64', 'Taskboard.app');
if (!existsSync(built)) { console.error('Build it first: pnpm build'); process.exit(1); }
const dest = join(homedir(), 'Applications', 'Taskboard.app');
try { execFileSync('osascript', ['-e', 'tell application id "com.taskboard.desktop" to quit'], { stdio: 'ignore' }); } catch { /* not running */ }
mkdirSync(join(homedir(), 'Applications'), { recursive: true });
rmSync(dest, { recursive: true, force: true });
execFileSync('ditto', [built, dest]);
console.log(`Installed ${dest}. Open it from Spotlight, Raycast or ~/Applications.`);
