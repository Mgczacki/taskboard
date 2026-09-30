import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TB_DIR } from './config.ts';

const FILE = join(TB_DIR, 'resources.jsonl');
const MAX_LINES = 1440;
let previousCpu = process.cpuUsage();
let previousTime = process.hrtime.bigint();

export function sampleResources(counts: () => Record<string, number>) {
  const now = process.hrtime.bigint();
  const cpu = process.cpuUsage();
  const elapsedUs = Number(now - previousTime) / 1000;
  const usedUs = cpu.user - previousCpu.user + cpu.system - previousCpu.system;
  previousTime = now;
  previousCpu = cpu;
  const memory = process.memoryUsage();
  const row = { at: new Date().toISOString(), pid: process.pid,
    cpuPct: Math.round(1000 * usedUs / elapsedUs) / 10,
    rssMb: Math.round(memory.rss / 1048576), heapMb: Math.round(memory.heapUsed / 1048576),
    externalMb: Math.round(memory.external / 1048576), ...counts() };
  try {
    appendFileSync(FILE, JSON.stringify(row) + '\n');
    if (statSync(FILE).size > 300_000) {
      const lines = readFileSync(FILE, 'utf8').trimEnd().split('\n');
      writeFileSync(FILE, lines.slice(-MAX_LINES).join('\n') + '\n');
    }
  } catch (error) { console.error('resource log', error); }
  return row;
}

export const resourceLogFile = () => existsSync(FILE) ? FILE : undefined;
