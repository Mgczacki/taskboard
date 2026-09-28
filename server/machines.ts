// Other machines running their own Taskboard server (for example over Tailscale: `tailscale serve --bg 4317`).
// This server polls each one, adds its tasks to the list with ids like "<machine>~<task id>", and forwards actions
// and terminals for those tasks to that machine with its token. Each machine keeps its own vault and tmux sessions.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TB_DIR } from './config.ts';

export interface Machine { id: string; name: string; url: string; token: string }
export interface MachineState { online: boolean; latency?: number; lastSeen?: string; error?: string; tasks: any[]; groups: any[] }

const FILE = join(TB_DIR, 'machines.json');
let machines: Machine[] = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : [];
const state = new Map<string, MachineState>();
const save = () => writeFileSync(FILE, JSON.stringify(machines, null, 2), { mode: 0o600 });
const listeners = new Set<(changed: any[], machineId: string) => void>();
export const onRemoteChange = (fn: (changed: any[], machineId: string) => void) => { listeners.add(fn); };

export const SEP = '~';
export const all = () => machines;
export const get = (id: string) => machines.find(m => m.id === id);
export const stateOf = (id: string) => state.get(id);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'machine';

export function add(name: string, url: string, token: string): Machine {
  let id = slug(name), n = 2; while (machines.some(m => m.id === id)) id = `${slug(name)}-${n++}`;
  const m: Machine = { id, name, url: url.replace(/\/+$/, ''), token: token.trim() };
  machines.push(m); save(); poll(m); return m;
}
export function remove(id: string) { machines = machines.filter(m => m.id !== id); state.delete(id); save(); }

// "studio~fix-login-12" → { machine, id }
export function split(fullId: string) { const i = fullId.indexOf(SEP); return i > 0 ? { machine: fullId.slice(0, i), id: fullId.slice(i + 1) } : null; }

export async function call(m: Machine, method: string, path: string, body?: unknown) {
  const r = await fetch(m.url + path, { method, headers: { 'content-type': 'application/json', 'x-taskboard-token': m.token }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  const text = await r.text(); let data: any; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, type: r.headers.get('content-type') || 'application/json' };
}

const tag = (m: Machine, t: any) => ({ ...t, id: m.id + SEP + t.id, machine: { id: m.id, name: m.name }, parent: t.parent ? m.id + SEP + t.parent : undefined });

async function poll(m: Machine) {
  const prev = state.get(m.id);
  const start = Date.now();
  try {
    const [tasks, groups] = await Promise.all([call(m, 'GET', '/api/tasks'), call(m, 'GET', '/api/groups')]);
    if (tasks.status !== 200) throw new Error(typeof tasks.data === 'object' ? tasks.data.error : String(tasks.status));
    const tagged = (tasks.data as any[]).map(t => tag(m, t));
    const changed = tagged.filter(t => { const o = prev?.tasks.find(x => x.id === t.id); return !o || o.updated !== t.updated || o.status !== t.status || o.waitMin !== t.waitMin; });
    state.set(m.id, { online: true, latency: Date.now() - start, lastSeen: new Date().toISOString(), tasks: tagged, groups: groups.data });
    if (changed.length || !prev?.online) listeners.forEach(f => f(changed, m.id));
  } catch (e) {
    state.set(m.id, { online: false, lastSeen: prev?.lastSeen, error: e instanceof Error ? e.message : String(e), tasks: prev?.tasks || [], groups: prev?.groups || [] });
    if (prev?.online !== false) listeners.forEach(f => f([], m.id));
  }
}
setInterval(() => machines.forEach(m => poll(m)), 2000);
machines.forEach(m => poll(m));

export const remoteTasks = () => machines.flatMap(m => state.get(m.id)?.tasks || []);
