// A new Antigravity account has its own HOME and macOS Keychain.
// The password goes through stdin, never through a process argument.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const keychain = (home: string) => join(home, 'Library', 'Keychains', 'antigravity-profile.keychain-db');
const passwordFile = (home: string) => join(home, '.taskboard-keychain-password');

function security(home: string, args: string[], input = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', args, { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 15000);
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => { stderr += b; });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`Keychain command failed: ${stderr.trim() || `exit ${code}`}`));
    });
    child.stdin.end(input);
  });
}

const paths = (output: string) => output.trim().split('\n').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);

export async function createProfile(home: string) {
  if (process.platform !== 'darwin') throw new Error('Antigravity account Keychains require macOS.');
  mkdirSync(join(home, 'Library', 'Keychains'), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, 'Library', 'Preferences'), { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const password = randomBytes(36).toString('base64url');
  writeFileSync(passwordFile(home), password, { mode: 0o600, flag: 'wx' });
  const path = keychain(home);
  await security(home, ['create-keychain', path], `${password}\n${password}\n`);
  await security(home, ['list-keychains', '-d', 'user', '-s', path]);
  await security(home, ['default-keychain', '-d', 'user', '-s', path]);
  await prepareProfile(home);
  // A fresh macOS Keychain locks after five minutes. A running agy process cannot unlock it again.
  await security(home, ['set-keychain-settings', path]);
}

export async function prepareProfile(home: string, runSecurity = security) {
  const path = keychain(home);
  if (!existsSync(path) || !existsSync(passwordFile(home))) throw new Error('The Antigravity account Keychain is missing.');
  await runSecurity(home, ['unlock-keychain', path], `${readFileSync(passwordFile(home), 'utf8')}\n`);
  const listed = paths(await runSecurity(home, ['list-keychains', '-d', 'user']));
  const selected = paths(await runSecurity(home, ['default-keychain', '-d', 'user']));
  if (listed.length !== 1 || listed[0] !== path || selected.length !== 1 || selected[0] !== path)
    throw new Error('The Antigravity account Keychain is not isolated.');
}
