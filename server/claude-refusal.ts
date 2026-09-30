import { openSync, readSync, closeSync, statSync } from 'node:fs';

export interface Refusal { command: string; reason: string; id: string; toolName: string }

export function lastRefusal(path: string, since: number): Refusal | null {
  let lines: string[];
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - 524288);
    const buf = Buffer.alloc(size - start);
    const fd = openSync(path, 'r');
    try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
    lines = buf.toString('utf8').split('\n');
    if (start) lines.shift();
  } catch { return null; }
  const tools = new Map<string, { command: string; toolName: string }>();
  let found: Refusal | null = null;
  for (const line of lines) {
    let row: any; try { row = JSON.parse(line); } catch { continue; }
    if ((Date.parse(row.timestamp || '') || 0) < since) continue;
    const parts = Array.isArray(row.message?.content) ? row.message.content : [];
    if (row.type === 'assistant') for (const part of parts) {
      if (part.type === 'tool_use' && part.id) tools.set(part.id, { command: part.name === 'Bash' ? String(part.input?.command || '') : String(part.name || ''), toolName: String(part.name || '') });
    }
    if (row.type === 'user') for (const part of parts) {
      const content = String(part.content || '');
      const match = content.match(/Permission for this action was denied by the Claude Code auto mode classifier\. Reason: \[([^\]]+)\]/);
      if (part.type === 'tool_result' && match) found = {
        id: String(part.tool_use_id || row.uuid || ''),
        command: tools.get(part.tool_use_id)?.command || 'Unknown command',
        toolName: tools.get(part.tool_use_id)?.toolName || '',
        reason: match[1],
      };
    }
  }
  return found;
}
