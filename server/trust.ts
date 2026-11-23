// Trust only folders Taskboard launches. Keep the earlier value so Settings can undo Taskboard's edit.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { HOME, TB_DIR } from './config.ts';
import * as accounts from './accounts.ts';
import type { Task } from './store.ts';

type Change = { agent: Task['agent']; file: string; path: string; before: string | boolean | null };
const changesFile = join(TB_DIR, 'trust-changes.json');
// Keep restoration and task starts in order while a Claude configuration lock is held by another process.
let pending: Promise<unknown> = Promise.resolve();
function inOrder<T>(change: () => Promise<T>): Promise<T> {
  const next = pending.then(change);
  pending = next.catch(() => {});
  return next;
}
const changes = (): Change[] => { try { return JSON.parse(readFileSync(changesFile, 'utf8')); } catch { return []; } };
const save = (file: string, value: string) => {
  const temp = `${file}.taskboard-${randomUUID()}`;
  try {
    writeFileSync(temp, value, { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  } finally { try { unlinkSync(temp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
};
const json = (file: string): any => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };

function claudeFile(acct: accounts.Account) {
  const dir = acct.isDefault ? process.env.CLAUDE_CONFIG_DIR : acct.dir;
  const current = join(dir || HOME, '.claude.json');
  const legacy = join(dir || join(HOME, '.claude'), '.config.json');
  // Claude Code 2.1.330 still reads an existing legacy file before the current file.
  if (existsSync(legacy) && (statSync(legacy).size > 0 || !existsSync(current))) return real(legacy);
  return real(current);
}

const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);

async function changeClaude(file: string, path: string, change: (cfg: any) => boolean) {
  // Use Claude's lock directory. Read only after acquiring it, so another Claude process cannot save an older read.
  const lock = `${file}.lock`;
  for (let attempt = 0; ; attempt++) {
    try { mkdirSync(lock, { mode: 0o700 }); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (attempt === 40) throw new Error(`Could not update Claude folder trust: ${lock} is still held. Try the task again.`);
      await setTimeout(50);
    }
  }
  try {
    const cfg = json(file);
    if (!object(cfg) || (cfg.projects !== undefined && !object(cfg.projects)) ||
        (cfg.projects?.[path] !== undefined && !object(cfg.projects[path])))
      throw new Error(`Could not update Claude folder trust: ${file} has an invalid projects entry.`);
    if (change(cfg)) save(file, JSON.stringify(cfg, null, 2));
  } finally { rmdirSync(lock); }
}
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

// The hooks that Taskboard gives every Codex task with -c (agents.ts codexFlags), as hooks/list names them in a key:
// "/<session-flags>/config.toml:<event>:0:0". The key and the hash do not depend on the task or its folder.
// Since task 242 every Codex task gets the hooks of server/hooks/codex-hook.mjs, not only the controller.
export const CODEX_HOOK_EVENTS = ['pre_tool_use', 'user_prompt_submit', 'post_tool_use', 'stop'] as const;
export const codexHookKey = (event: string) => `/<session-flags>/config.toml:${event}:0:0`;
export const isTaskboardCodexHook = (key: string) => (CODEX_HOOK_EVENTS as readonly string[]).some(e => key === codexHookKey(e));

// Codex does not read hooks.state from -c overrides. Its hook review reads this value from the account config.
// Trust only the hash that Codex reports for one of Taskboard's own hook commands.
export function trustCodexHook(t: Task, key: string, hash: string) {
  if (t.agent !== 'codex') throw new Error('Only a Codex task has Codex hooks.');
  if (!isTaskboardCodexHook(key))
    throw new Error(`Codex listed the hook ${JSON.stringify(key)}, which is not a Taskboard hook, so Taskboard did not trust it. Report this to the Taskboard developer.`);
  if (!/^sha256:[a-f0-9]{64}$/.test(hash))
    throw new Error(`Codex reported the hash ${JSON.stringify(hash)} for the Taskboard hook ${key}, which is not a sha256 hash. Report this to the Taskboard developer.`);
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

export function trust(t: Task) { return inOrder(() => trustTask(t)); }

async function trustTask(t: Task) {
  const path = real(t.cwd);
  const acct = accounts.get(t.account) || accounts.defaultFor(t.agent);
  const file = t.agent === 'antigravity' ? join(accounts.agyConfigDir(acct), 'settings.json')
    : t.agent === 'codex' ? join(acct.isDefault ? join(HOME, '.codex') : acct.dir, 'config.toml')
    : claudeFile(acct);
  if (t.agent === 'claude') {
    return changeClaude(file, path, cfg => {
      cfg.projects ??= {};
      cfg.projects[path] ??= {};
      const before = cfg.projects[path].hasTrustDialogAccepted ?? null;
      if (before === true) return false;
      if (before !== null && typeof before !== 'boolean') throw new Error(`Invalid hasTrustDialogAccepted in ${file}.`);
      const recorded = changes();
      if (!recorded.some(c => c.file === file && c.path === path)) {
        recorded.push({ agent: t.agent, file, path, before });
        // Record the old value first. restore() checks whether the trust write took effect.
        save(changesFile, JSON.stringify(recorded, null, 2));
      }
      cfg.projects[path].hasTrustDialogAccepted = true;
      return true;
    });
  }
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
  }
  save(changesFile, JSON.stringify(recorded, null, 2));
}

export function restore() { return inOrder(restoreChanges); }

async function restoreChanges() {
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
        await changeClaude(real(c.file), c.path, cfg => {
          if (cfg.projects?.[c.path]?.hasTrustDialogAccepted !== true) return false;
          if (c.before === null) delete cfg.projects[c.path].hasTrustDialogAccepted;
          else cfg.projects[c.path].hasTrustDialogAccepted = c.before;
          return true;
        });
      }
    } catch (error) { console.error('Could not restore folder trust', c.file, error); remaining.push(c); }
  }
  save(changesFile, JSON.stringify(remaining, null, 2));
}
