import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TB_DIR } from './config.ts';
import * as push from './push.ts';

export type StandingAction = 'push' | 'deploy-dev' | 'catalog-stage';
export interface StandingRule { id: string; action: StandingAction; actor: string; target: string; limitPerDay: number; created: string }
const file = join(TB_DIR, 'standing-approvals.json');
const auditFile = join(TB_DIR, 'standing-approval-actions.jsonl');
const rules: StandingRule[] = (() => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return []; } })();
const audit: { at: string; rule: string; target: string }[] = (() => {
  try { return readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x)); }
  catch { return []; }
})();
export const all = () => rules.slice();
export function add(input: Pick<StandingRule, 'action' | 'actor' | 'target' | 'limitPerDay'>, protectedBranches: string[] = []) {
  if (!['push', 'deploy-dev', 'catalog-stage'].includes(input.action)) throw new Error('This action cannot have a standing approval.');
  if (!input.actor || !input.target || !Number.isInteger(input.limitPerDay) || input.limitPerDay < 1 || input.limitPerDay > 20)
    throw new Error('Give one actor, one target and a daily limit from 1 to 20.');
  if (input.action === 'push' && push.isProtectedBranch(input.target, undefined, protectedBranches)) throw new Error('A protected branch cannot have standing approval.');
  if (input.action === 'deploy-dev' && !input.target.endsWith('@dev')) throw new Error('Standing deploy approval covers a target ending in @dev only.');
  if (input.action === 'catalog-stage' && !input.target.endsWith('@stage')) throw new Error('Standing catalog approval covers a target ending in @stage only.');
  const r = { ...input, id: randomUUID().slice(0, 8), created: new Date().toISOString() };
  rules.push(r); writeFileSync(file, JSON.stringify(rules)); return r;
}
export function remove(id: string) { const i = rules.findIndex(x => x.id === id); if (i < 0) return false; rules.splice(i, 1); writeFileSync(file, JSON.stringify(rules)); return true; }
export function match(action: StandingAction, actor: string, target: string) {
  return rules.find(r => r.action === action && r.actor === actor && r.target === target &&
    audit.filter(a => a.rule === r.id && Date.now() - Date.parse(a.at) < 86400000).length < r.limitPerDay);
}
export function use(rule: StandingRule, target: string) {
  const row = { at: new Date().toISOString(), rule: rule.id, target };
  audit.push(row); appendFileSync(auditFile, JSON.stringify(row) + '\n'); return row;
}
