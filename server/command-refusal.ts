import { closeSync, openSync, readSync, statSync } from 'node:fs';

export interface CommandRefusal { id: string; command: string; reason: string; cwd?: string; toolName?: string }

export function lastCodexRefusal(path: string, since: number): CommandRefusal | null {
  let lines: string[];
  try {
    const size = statSync(path).size, start = Math.max(0, size - 524288), data = Buffer.alloc(size - start);
    const fd = openSync(path, 'r');
    try { readSync(fd, data, 0, data.length, start); } finally { closeSync(fd); }
    lines = data.toString('utf8').split('\n'); if (start) lines.shift();
  } catch { return null; }
  const calls = new Map<string, { command: string; cwd?: string }>(); let found: CommandRefusal | null = null;
  for (const line of lines) {
    let row: any; try { row = JSON.parse(line); } catch { continue; }
    if ((Date.parse(row.timestamp || '') || 0) < since || row.type !== 'response_item') continue;
    const p = row.payload || {};
    if (['function_call', 'custom_tool_call'].includes(p.type) && p.call_id) {
      if (['exec_command', 'functions.exec_command'].includes(p.name)) {
        try { const input = JSON.parse(p.arguments || '{}'); calls.set(p.call_id, { command: String(input.cmd || ''), ...(typeof input.workdir === 'string' ? { cwd: input.workdir } : {}) }); } catch { /* no command */ }
      } else if (p.name === 'functions.exec') {
        const source = String(p.input || p.arguments || '');
        const match = source.match(/\bcmd\s*:\s*("(?:[^"\\]|\\.)*")/);
        if (match) {
          try {
            const workdir = source.match(/\bworkdir\s*:\s*("(?:[^"\\]|\\.)*")/);
            calls.set(p.call_id, { command: JSON.parse(match[1]), ...(workdir ? { cwd: JSON.parse(workdir[1]) } : {}) });
          } catch { /* dynamic command */ }
        }
      }
    }
    if (!['function_call_output', 'custom_tool_call_output'].includes(p.type) || !p.call_id || !calls.has(p.call_id)) continue;
    const output = String(p.output || p.content || '');
    const match = output.match(/(?:rejected by (?:auto.review|the sandbox)|sandbox (?:denied|blocked)|Command blocked by (?:PreToolUse|the sandbox)|permission (?:denied|refused))[^\n]{0,240}/i);
    if (match) found = { id: p.call_id, ...calls.get(p.call_id)!, reason: match[0].slice(0, 240) };
  }
  return found;
}
