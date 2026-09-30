// Trust only folders Taskboard launches. Keep the earlier value so Settings can undo Taskboard's edit.
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME, TB_DIR } from './config.ts';
import * as accounts from './accounts.ts';
import type { Task } from './store.ts';

type Change = { agent: Task['agent']; file: string; path: string; before: string | boolean | null };
const changesFile = join(TB_DIR, 'trust-changes.json');
const changes = (): Change[] => { try { return JSON.parse(readFileSync(changesFile, 'utf8')); } catch { return []; } };
const save = (file: string, value: string) => {
  const temp = `${file}.taskboard-${process.pid}`;
  writeFileSync(temp, value, { mode: 0o600 });
  renameSync(temp, file);
};
const json = (file: string): any => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };
const tomlPath = (path: string) => `[projects.${JSON.stringify(path)}]`;
const section = (body: string, path: string) => {
  const header = tomlPath(path);
  const start = body.split('\n').findIndex(line => line.trim() === header);
  if (start < 0) return null;
  const lines = body.split('\n');
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  return { lines, start, end };
};

// Codex does not read hooks.state from -c overrides. Its hook review reads this value from the account config.
// Trust only the hash that Codex reports for Taskboard's guard command.
export function trustCodexHook(t: Task, key: string, hash: string) {
  if (t.agent !== 'codex' || key !== '/<session-flags>/config.toml:pre_tool_use:0:0' || !/^sha256:[a-f0-9]{64}$/.test(hash))
    throw new Error('Codex reported an unexpected Taskboard guard hook.');
  const acct = accounts.get(t.account) || accounts.defaultFor('codex');
  const file = join(acct.isDefault ? join(HOME, '.codex') : acct.dir, 'config.toml');
  const body = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const header = `[hooks.state.${JSON.stringify(key)}]`;
  const lines = body.split('\n');
  const start = lines.findIndex(line => line.trim() === header);
  let next: string;
  if (start < 0) next = `${body.trimEnd()}\n\n${header}\ntrusted_hash = ${JSON.stringify(hash)}\n`;
  else {
    let end = start + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
    const old = lines.slice(start + 1, end);
    if (old.some(line => line.trim() === `trusted_hash = ${JSON.stringify(hash)}`)) return;
    next = [...lines.slice(0, start + 1), ...old.filter(line => !/^\s*trusted_hash\s*=/.test(line)), `trusted_hash = ${JSON.stringify(hash)}`, ...lines.slice(end)].join('\n');
  }
  save(file, next);
}

export function trust(t: Task) {
  const path = real(t.cwd);
  const acct = accounts.get(t.account) || accounts.defaultFor(t.agent);
  const file = t.agent === 'antigravity' ? join(accounts.agyConfigDir(acct), 'settings.json')
    : t.agent === 'codex' ? join(acct.isDefault ? join(HOME, '.codex') : acct.dir, 'config.toml')
    : acct.isDefault ? join(HOME, '.claude.json') : join(acct.dir, '.claude.json');
  const recorded = changes();
  if (t.agent === 'codex') {
    const body = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const s = section(body, path);
    const match = s?.lines.slice(s.start + 1, s.end).join('\n').match(/^\s*trust_level\s*=\s*"([^"]+)"/m);
    const before = match?.[1] || null;
    if (before === 'trusted') return;
    const next = s ? [...s.lines.slice(0, s.start + 1), ...s.lines.slice(s.start + 1, s.end).filter(line => !/^\s*trust_level\s*=/.test(line)), 'trust_level = "trusted"', ...s.lines.slice(s.end)].join('\n')
      : `${body.trimEnd()}\n\n${tomlPath(path)}\ntrust_level = "trusted"\n`;
    save(file, next);
    if (!recorded.some(c => c.file === file && c.path === path)) recorded.push({ agent: t.agent, file, path, before });
  } else if (t.agent === 'antigravity') {
    const cfg = json(file);
    const list: string[] = Array.isArray(cfg.trustedWorkspaces) ? cfg.trustedWorkspaces : [];
    if (list.some(p => real(p) === path)) return;
    cfg.trustedWorkspaces = [...list, path];
    save(file, JSON.stringify(cfg, null, 2));
    if (!recorded.some(c => c.file === file && c.path === path)) recorded.push({ agent: t.agent, file, path, before: null });
  } else {
    const cfg = json(file);
    cfg.projects ||= {};
    cfg.projects[path] ||= {};
    const before = cfg.projects[path].hasTrustDialogAccepted ?? null;
    if (before === true) return;
    cfg.projects[path].hasTrustDialogAccepted = true;
    save(file, JSON.stringify(cfg, null, 2));
    if (!recorded.some(c => c.file === file && c.path === path)) recorded.push({ agent: t.agent, file, path, before });
  }
  save(changesFile, JSON.stringify(recorded, null, 2));
}

export function restore() {
  const remaining: Change[] = [];
  for (const c of changes()) {
    try {
      if (c.agent === 'codex') {
        const body = readFileSync(c.file, 'utf8');
        const s = section(body, c.path);
        if (!s || !/^\s*trust_level\s*=\s*"trusted"/m.test(s.lines.slice(s.start + 1, s.end).join('\n'))) continue;
        const rows = s.lines.slice(s.start + 1, s.end).filter(line => !/^\s*trust_level\s*=/.test(line));
        if (c.before !== null) rows.unshift(`trust_level = ${JSON.stringify(c.before)}`);
        const next = c.before === null && rows.every(line => !line.trim())
          ? [...s.lines.slice(0, s.start), ...s.lines.slice(s.end)] : [...s.lines.slice(0, s.start + 1), ...rows, ...s.lines.slice(s.end)];
        save(c.file, next.join('\n'));
      } else if (c.agent === 'antigravity') {
        const cfg = json(c.file);
        if (!Array.isArray(cfg.trustedWorkspaces)) continue;
        cfg.trustedWorkspaces = cfg.trustedWorkspaces.filter((p: string) => real(p) !== c.path);
        save(c.file, JSON.stringify(cfg, null, 2));
      } else {
        const cfg = json(c.file);
        if (cfg.projects?.[c.path]?.hasTrustDialogAccepted !== true) continue;
        if (c.before === null) delete cfg.projects[c.path].hasTrustDialogAccepted;
        else cfg.projects[c.path].hasTrustDialogAccepted = c.before;
        save(c.file, JSON.stringify(cfg, null, 2));
      }
    } catch (error) { console.error('Could not restore folder trust', c.file, error); remaining.push(c); }
  }
  save(changesFile, JSON.stringify(remaining, null, 2));
}
