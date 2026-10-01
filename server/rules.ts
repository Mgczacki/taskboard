// The user's rules files: free text that tells an agent how to work. controller.md goes into the controller's
// instructions (agents.ts controllerMd), task.md into the instructions of every task session (agents.ts taskInstructions).
// A session reads the file when it starts, so a saved change reaches the next new session. The files live in
// TB_DIR/rules, never in a project folder, so a project's own CLAUDE.md and AGENTS.md stay unchanged.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TB_DIR } from './config.ts';

export type RulesKind = 'controller' | 'task';
export const RULES_KINDS: RulesKind[] = ['controller', 'task'];
export const RULES_DIR = join(TB_DIR, 'rules');
// tmux refuses a command longer than about 16 KB (observed with tmux 3.7c), and the task rules go on the agent's
// command line with the other task instructions (about 11.5 KB for a worktree task without rules), so they stay short.
// agents.ts command uses a copy in the task folder when a long first prompt leaves no room for them.
// The controller rules go into a file (CLAUDE.md, AGENTS.md).
export const MAX_RULES_CHARS: Record<RulesKind, number> = { controller: 50_000, task: 2_000 };
export const PREVIEW_LINES = 4;

export const isKind = (k: unknown): k is RulesKind => RULES_KINDS.includes(k as RulesKind);
export const rulesFile = (k: RulesKind) => join(RULES_DIR, `${k}.md`);

export function read(k: RulesKind): string {
  try { return readFileSync(rulesFile(k), 'utf8'); } catch { return ''; }
}

// The first lines that are not empty, for the preview on the Settings page.
export function preview(text: string, lines = PREVIEW_LINES): { lines: string[]; more: boolean } {
  const all = text.split('\n').map(l => l.trimEnd()).filter(l => l.trim());
  return { lines: all.slice(0, lines), more: all.length > lines };
}

export function info(k: RulesKind) {
  const text = read(k);
  const f = rulesFile(k);
  return { kind: k, file: f, text, chars: text.length, max: MAX_RULES_CHARS[k], updated: existsSync(f) ? statSync(f).mtime.toISOString() : null, preview: preview(text) };
}

export function write(k: RulesKind, text: unknown) {
  if (typeof text !== 'string') throw new Error('The rules text must be a string.');
  const clean = text.replace(/\r\n/g, '\n');
  if (clean.length > MAX_RULES_CHARS[k]) throw new Error(`The ${k} rules are ${clean.length} characters. The maximum is ${MAX_RULES_CHARS[k]}.`);
  mkdirSync(RULES_DIR, { recursive: true });
  // write a new file and rename it, so a session that starts during the save reads the old or the new text
  const tmp = `${rulesFile(k)}.tmp`;
  writeFileSync(tmp, clean); renameSync(tmp, rulesFile(k));
  return info(k);
}

// The text added to an agent's instructions, or '' when the file is empty.
export function section(k: RulesKind): string {
  const text = read(k).trim();
  if (!text) return '';
  const who = k === 'controller' ? 'the controller' : 'every task session';
  return `## The user's rules for ${who}\nThe user wrote these rules in Taskboard's Settings. A project's own CLAUDE.md or AGENTS.md can add more rules. When one of these rules conflicts with a Taskboard rule above, follow the Taskboard rule.\n\n${text}`;
}
