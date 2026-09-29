// Finds task document paths in terminal rows, for the Command-click links in Terminal.tsx.
// Agents write a path in many forms: ~/AgentVault/tasks/…, AgentVault/tasks/…, tasks/<task>/outbox/…, outbox/…,
// an absolute path or a file:// URL, often in quotes, parentheses or a Markdown link, or with a full stop after it.
// Claude Code breaks a long path over two rows with its own line break and an indent, and tmux redraws a wrapped
// row as two separate rows. So a row is joined to the next row when a path runs to the end of the row. Each match
// then lists its candidate paths, longest first; the server lookup decides which one is a real document.

export interface Row { text: string; wrapped: boolean } // wrapped: xterm marks this row as the soft-wrapped rest of the row above
export interface Cell { row: number; col: number }
export interface Joined { text: string; cells: Cell[]; breaks: number[] } // breaks: text offsets where a row joined without a soft wrap starts
export interface PathMatch { start: number; candidates: { text: string; end: number }[] }

const pathChar = /[^\s"'`<>()[\]{}]/;
const pathRun = /[^\s"'`<>()[\]{}]+/g;
const quoted = /(["'`])([^\r\n"'`]+?)\1/g;
const documentPath = /(?:^|\/)(?:inbox|outbox)\/[^/]+$/;
const trailing = /[.,;:!?*]+$/;

// The previous row's last word looks like the first part of a path, and the next row starts with more of it.
export function continues(previous: string, next: Row): boolean {
  if (next.wrapped) return true;
  const end = previous.trimEnd(), start = next.text.trimStart();
  if (!end || !start || !pathChar.test(end[end.length - 1]) || !pathChar.test(start[0])) return false;
  const word = end.slice(end.search(/\S+$/));
  return word.includes('/');
}

export function joinRows(rows: Row[]): Joined {
  let text = '';
  const cells: Cell[] = [], breaks: number[] = [];
  rows.forEach((row, index) => {
    const next = rows[index + 1];
    // a soft-wrapped row continues at the next cell, so its trailing spaces are part of the text
    const body = next?.wrapped ? row.text : row.text.trimEnd();
    let lead = 0;
    if (index > 0 && !row.wrapped) {
      if (continues(rows[index - 1].text, row)) { lead = body.length - body.trimStart().length; breaks.push(text.length); }
      else { text += '\n'; cells.push({ row: index, col: 0 }); }
    }
    for (let col = lead; col < body.length; col++) { text += body[col]; cells.push({ row: index, col }); }
  });
  return { text, cells, breaks };
}

// A path starts at file://, ~/, /, ./, AgentVault/, tasks/, inbox/ or outbox/. Words glued in front of it, such as
// "path:" or "at=", are left out.
function pathStart(word: string): number {
  const file = word.indexOf('file://');
  if (file >= 0) return file;
  if (/[a-z][\w+.-]*:\/\//i.test(word)) return -1; // a web address: the web links add-on opens it
  const at = word.search(/(?:^|[:=])(?:~\/|\/|\.\/|AgentVault\/|tasks\/|inbox\/|outbox\/)/);
  if (at < 0) {
    const inner = word.search(/(?:^|\/)(?:tasks\/[^/]+\/)?(?:inbox|outbox)\//);
    return inner < 0 ? -1 : word[inner] === '/' ? inner + 1 : inner;
  }
  return /[:=]/.test(word[at]) ? at + 1 : at;
}

function candidates(text: string, start: number, end: number, breaks: number[]): PathMatch['candidates'] {
  const ends = [end, ...breaks.filter(b => b > start && b < end).sort((a, b) => b - a)];
  const out: PathMatch['candidates'] = [];
  for (const e of ends) {
    const path = text.slice(start, e).replace(trailing, '');
    if (documentPath.test(path.replace(/[#:][^/]*$/, '')) && !out.some(c => c.text === path)) out.push({ text: path, end: start + path.length });
  }
  return out;
}

export function findPaths(joined: Pick<Joined, 'text' | 'breaks'>): PathMatch[] {
  const { text, breaks } = joined;
  const found: (PathMatch & { end: number })[] = [];
  // a quoted path may contain spaces or parentheses; the words inside it are not separate paths
  for (const m of text.matchAll(quoted)) {
    const start = m.index! + 1, end = start + m[2].length;
    if (!/[\s()]/.test(m[2])) continue;
    const list = candidates(text, start, end, breaks);
    if (list.length) found.push({ start, end, candidates: list });
  }
  for (const m of text.matchAll(pathRun)) {
    const offset = pathStart(m[0]);
    if (offset < 0) continue;
    const start = m.index! + offset, end = m.index! + m[0].length;
    if (found.some(f => start < f.end && end > f.start)) continue;
    const list = candidates(text, start, end, breaks);
    if (list.length) found.push({ start, end, candidates: list });
  }
  return found.sort((a, b) => a.start - b.start).map(({ start, candidates }) => ({ start, candidates }));
}
