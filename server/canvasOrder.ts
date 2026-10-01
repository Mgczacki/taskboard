// The order of the terminals in the Canvas views that are not a group: Ungrouped, Needs you + unread, All live tasks
// and the hand-picked views (t:<id,id,...>). A group view uses the order of the group's tasks list (reorderTasks() in
// groups.ts), so a group is not stored here.
// Stored in TASKBOARD_DIR/canvas-order.json as { "<view key>": ["<task id>", ...] }. The Canvas page shows the listed
// tasks first, in this order, and every other task of the view after them (web/src/tileOrder.ts).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TB_DIR } from './config.ts';

const FILE = join(TB_DIR, 'canvas-order.json');
// a hand-picked view gets a new key for each new set of tasks, so the file keeps only the newest keys
const MAX_KEYS = 100;
const orders = new Map<string, string[]>();
const listeners = new Set<() => void>();
export const onCanvasOrderChange = (fn: () => void) => { listeners.add(fn); };

export function load() {
  orders.clear();
  if (!existsSync(FILE)) return;
  try {
    const data = JSON.parse(readFileSync(FILE, 'utf8'));
    for (const [k, v] of Object.entries(data)) if (validKey(k) && Array.isArray(v)) orders.set(k, v.filter(x => typeof x === 'string'));
  } catch { /* a damaged file starts empty; the next move writes it again */ }
}
export const all = (): Record<string, string[]> => Object.fromEntries(orders);
export const validKey = (k: string) => k === 'ungrouped' || k === 'needs' || k === 'live' || /^t:[^,]+(,[^,]+)*$/.test(k);

// Saves `ids` as the order of view `key`. The list replaces the old one. Returns false when nothing changed.
export function set(key: string, ids: string[]): boolean {
  if (!validKey(key)) throw new Error(`${key} is not a Canvas view that keeps its own order.`);
  const list = [...new Set(ids)];
  const old = orders.get(key);
  if (old && old.length === list.length && old.every((x, i) => x === list[i])) return false;
  const before = new Map(orders);
  orders.delete(key); orders.set(key, list);
  while (orders.size > MAX_KEYS) orders.delete(orders.keys().next().value!);
  try { writeFileSync(FILE, JSON.stringify(all(), null, 1) + '\n'); }
  catch (e) { orders.clear(); for (const [k, v] of before) orders.set(k, v); throw e; }
  listeners.forEach(f => f());
  return true;
}
