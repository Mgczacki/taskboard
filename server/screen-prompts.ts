// Reads a question or a dialog that an agent shows in its terminal, so the Waiting page can show it as a card.
// Each known prompt has a name, its options, the option that is selected now, and how an option is chosen:
// a key that the dialog itself shows (a digit, "y", Escape) or arrow keys and Enter. A prompt that looks like a
// question but matches no known pattern comes back as 'unknown': the card shows the screen, and Taskboard types nothing.
// The samples are from Claude Code 2.1.287, Codex 0.160.0 and Antigravity 1.2.14 (tests/screen-prompts.test.ts).
import { createHash } from 'node:crypto';

export type Risk = 'wide-access' | 'installs' | 'spends' | 'exits';
export type PromptAgent = 'claude' | 'codex' | 'antigravity';
export interface ScreenOption { label: string; key?: string; risk?: Risk }
export interface ScreenPrompt {
  name: string;
  kind: 'command' | 'plan' | 'dialog' | 'signin' | 'unknown';
  question: string;
  options: ScreenOption[];
  selected: number;          // index of the highlighted option, -1 when none is highlighted
  answerable: boolean;       // false: the card shows the screen and "Open terminal" only
  details: { command?: string; reason?: string; title?: string; plan?: string; cwd?: string };
  hash: string;              // name, question, options and command; the highlight is not part of it
  excerpt: string;           // the rows that the card shows
}

const MARKS = '❯›>';
const NUMBERED = new RegExp(`^(\\s*)([${MARKS}])?\\s*(\\d{1,2})\\.\\s+(.*\\S)\\s*$`);
const SOLID = /^\s*[─━]{20,}\s*$/;
const DASHED = /^\s*[╌┄]{20,}\s*$/;

export function riskOf(label: string, question = ''): Risk | undefined {
  if (/always allow|don['’]t ask again|do not ask again|and always|allow all\b|switch to accept edits/i.test(label)) return 'wide-access';
  if (/\b(update now|install|upgrade)\b|\bcurl\b|\bwget\b|\|\s*(ba|z)?sh\b/i.test(label)) return 'installs';
  if (/request (a limit )?increase|add credits|buy credits/i.test(label) || (/request (a limit )?increase\?/i.test(question) && /^yes\b/i.test(label))) return 'spends';
  if (/^(no, exit|quit|exit)$/i.test(label.trim())) return 'exits';
  return undefined;
}

const hashOf = (...parts: string[]) => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);

interface Block { start: number; end: number; options: ScreenOption[]; selected: number }
// The last numbered list on the screen ("❯ 1. Yes" … "3. No"). Rows between numbered rows belong to the row above:
// a long label wraps onto the next row. A wrapped row that filled the screen width joins without a space.
function numberedBlock(rows: string[]): Block | null {
  let last = -1;
  for (let i = rows.length - 1; i >= 0 && i >= rows.length - 30; i--) if (NUMBERED.test(rows[i])) { last = i; break; }
  if (last < 0) return null;
  const width = Math.max(...rows.map(r => r.length));
  const nums: number[] = [];
  let first = last, want = Number(rows[last].match(NUMBERED)![3]) - 1;
  for (let i = last - 1; i >= 0 && want >= 1 && last - i < 30; i--) {
    const m = rows[i].match(NUMBERED);
    if (m && Number(m[3]) === want) { first = i; want--; continue; }
    if (m || !rows[i].trim() || SOLID.test(rows[i])) break;
  }
  if (want >= 1) return null; // the list does not start at 1
  const options: ScreenOption[] = []; let selected = -1; let end = last;
  for (let i = first; i <= last; i++) {
    const m = rows[i].match(NUMBERED);
    if (m) { if (m[2]) selected = options.length; options.push({ label: m[4] }); nums.push(i); continue; }
    const prev = options[options.length - 1];
    const sep = rows[i - 1].length >= width - 1 ? '' : ' ';
    prev.label = (prev.label + sep + rows[i].trim()).trim();
  }
  // a wrapped last label continues below the last numbered row, up to a blank row or the footer
  for (let i = last + 1; i < rows.length && i <= last + 3; i++) {
    const indent = rows[i].length - rows[i].trimStart().length;
    if (!rows[i].trim() || indent < 4 || /Esc to cancel|enter to|to navigate|Press enter/i.test(rows[i])) break;
    const prev = options[options.length - 1];
    prev.label = (prev.label + (rows[i - 1].length >= width - 1 ? '' : ' ') + rows[i].trim()).trim(); end = i;
  }
  options.forEach(o => { o.label = o.label.replace(/\s+/g, ' ').trim(); });
  return { start: first, end, options, selected };
}

// A list without numbers ("❯ No, exit" / "  Yes, I trust this folder") below its question row. The options are the
// rows whose text starts in the same column as the text of the highlighted row; explanation rows start further left.
function plainBlock(rows: string[], from: number): Block | null {
  const MARKED = new RegExp(`^(\\s*[${MARKS}]\\s+)(\\S.*\\S)\\s*$`);
  let mark = -1;
  for (let i = from + 1; i < rows.length && i <= from + 10; i++) if (MARKED.test(rows[i])) { mark = i; break; }
  if (mark < 0) return null;
  const col = rows[mark].match(MARKED)![1].length;
  const isOption = (r: string) => MARKED.test(r) ? r.match(MARKED)![1].length === col : r.length > col && !r.slice(0, col).trim() && r[col] !== ' ';
  let start = mark, end = mark;
  while (start - 1 > from && isOption(rows[start - 1])) start--;
  while (end + 1 < rows.length && isOption(rows[end + 1]) && !/enter|esc\b|navigate|confirm/i.test(rows[end + 1])) end++;
  const options: ScreenOption[] = []; let selected = -1;
  for (let i = start; i <= end; i++) { if (MARKED.test(rows[i])) selected = options.length; options.push({ label: rows[i].trim().replace(new RegExp(`^[${MARKS}]\\s+`), '') }); }
  return options.length >= 2 && options.length <= 6 ? { start, end, options, selected } : null;
}

const questionAbove = (rows: string[], start: number) => {
  for (let i = start - 1; i >= 0 && start - i <= 12; i--) if (/\?\s*$/.test(rows[i].trim())) return { row: i, text: rows[i].trim() };
  return null;
};
const between = (rows: string[], from: number, to: number) => rows.slice(from, to).map(r => r.trim()).filter(Boolean).join('\n');
// the rows between the last two dashed rules above a row (Claude Code shows the command and the plan there)
function dashed(rows: string[], before: number): { text: string; top: number } | null {
  let b = -1;
  for (let i = before - 1; i >= 0 && before - i < 40; i--) if (DASHED.test(rows[i])) { b = i; break; }
  if (b < 0) return null;
  for (let i = b - 1; i >= 0 && b - i < 40; i--) if (DASHED.test(rows[i])) return { text: between(rows, i + 1, b), top: i };
  return null;
}
const excerptOf = (rows: string[], from: number, to: number) => rows.slice(Math.max(0, from), to + 1).join('\n').replace(/\s+$/, '');
const tail = (rows: string[], n: number) => rows.filter(r => r.trim()).slice(-n).join('\n');

function make(name: string, kind: ScreenPrompt['kind'], question: string, block: Block | null, details: ScreenPrompt['details'], excerpt: string, keys?: 'digits' | 'shortcuts', answerable = true): ScreenPrompt {
  const options = (block?.options || []).map((o, i) => {
    const shortcut = o.label.match(/\((\w|esc)\)\s*$/i)?.[1];
    const key = keys === 'digits' ? String(i + 1) : keys === 'shortcuts' && shortcut ? (shortcut.toLowerCase() === 'esc' ? 'Escape' : shortcut) : undefined;
    return { label: o.label, ...(key ? { key } : {}), ...(riskOf(o.label, question) ? { risk: riskOf(o.label, question) } : {}) };
  });
  return { name, kind, question, options, selected: block?.selected ?? -1, answerable: answerable && options.length > 0, details, excerpt,
    hash: hashOf(name, question, details.command || '', ...options.map(o => o.label)) };
}

// Codex: questions from request_user_input wait above the input box ("? 3 questions" / "shift+← to answer").
export const CODEX_QUESTIONS = /\?\s+(\d+)\s+questions?\b[^\n]*\n[^\n]*to answer/;
const AGY_APPROVAL = /^\s*(>\s*)?1\. Yes\b[\s\S]*\bNo, (cancel|deny)\b/m;

export function parsePrompt(agent: PromptAgent, screen: string): ScreenPrompt | null {
  const rows = screen.split('\n').map(r => r.replace(/\s+$/, ''));
  while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
  const text = rows.slice(-45).join('\n');
  const find = (re: RegExp) => { for (let i = rows.length - 1; i >= 0 && i >= rows.length - 45; i--) if (re.test(rows[i])) return i; return -1; };

  // sign-in screens: the user signs in in the terminal
  const signin = agent === 'claude' ? find(/Select login method/) : agent === 'codex' ? find(/Sign in with ChatGPT|Please log in/) : -1;
  if (signin >= 0) return make(`${agent}-signin`, 'signin', rows[signin].trim().replace(/:$/, ''), numberedBlock(rows), {}, tail(rows, 15), undefined, false);

  if (agent === 'claude') {
    const trust = find(/Is this a project you created or one you trust\?|Do you trust the files in this folder\?/);
    if (trust >= 0) {
      const block = plainBlock(rows, trust);
      const path = rows.slice(Math.max(0, trust - 4), trust).map(r => r.trim()).find(r => r.startsWith('/') || r.startsWith('~'));
      const question = rows[trust].trim().replace(/^Quick safety check:\s*/, '').replace(/\?.*$/, '?');
      if (block) return make('claude-trust', 'dialog', question, block, { cwd: path }, excerptOf(rows, trust - 3, block.end + 1));
    }
    if (/Enter to select · ↑\/↓ to navigate/.test(text) && /[☐☒✔]/.test(text)) {
      const q = questionAbove(rows, rows.length);
      return make('claude-question', 'unknown', q?.text || 'Claude Code asks a question.', numberedBlock(rows), {}, tail(rows, 15), undefined, false);
    }
    const block = numberedBlock(rows);
    if (block && /Esc to cancel|Tab to amend|shift\+tab to approve|ctrl\+g to edit/i.test(rows.slice(block.end).join('\n'))) {
      const q = questionAbove(rows, block.start);
      if (q && /Would you like to proceed\?/.test(q.text) && block.options.some(o => /auto-accept edits|manually approve edits/.test(o.label))) {
        const plan = dashed(rows, q.row);
        // "3. Tell Claude what to change" needs typed text; the card sends that through the hook or the terminal
        const options = { ...block, options: block.options.filter(o => !/Tell Claude what to change/.test(o.label)) };
        return make('claude-plan', 'plan', q.text, options, { plan: plan?.text }, excerptOf(rows, q.row, block.end), 'digits');
      }
      if (q && /^Do you want to /.test(q.text)) {
        const cmd = dashed(rows, q.row);
        let title = '';
        if (cmd) for (let i = cmd.top - 1; i >= 0 && cmd.top - i < 6; i--) if (SOLID.test(rows[i])) { title = between(rows, i + 1, cmd.top).split('\n').join(' · '); break; }
        return make('claude-permission', 'command', q.text, block, { command: cmd?.text, title: title || undefined }, excerptOf(rows, q.row, block.end), 'digits');
      }
    }
  }

  if (agent === 'codex') {
    const block = numberedBlock(rows);
    const approval = find(/Would you like to (run the following command|make the following edits|grant|allow)/);
    if (approval >= 0 && block && block.start > approval) {
      const body = rows.slice(approval + 1, block.start);
      const reasonRow = body.find(r => /^\s*Reason:/.test(r));
      const cmdAt = body.findIndex(r => /^\s*\$ /.test(r));
      const command = cmdAt >= 0 ? body.slice(cmdAt).map(r => r.trim()).join(' ').replace(/^\$ /, '').trim() : undefined;
      return make('codex-approval', 'command', rows[approval].trim(), block, { command, reason: reasonRow?.replace(/^\s*Reason:\s*/, '').trim() }, excerptOf(rows, approval, block.end), 'shortcuts');
    }
    const update = find(/Update available/);
    if (update >= 0 && block && block.start > update) return make('codex-update', 'dialog', rows[update].trim().replace(/^[^A-Za-z]+/, ''), block, {}, excerptOf(rows, update, block.end + 1));
    const usage = find(/Usage limit reached/);
    if (usage >= 0 && block && block.start > usage && /Request increase\?/.test(text)) {
      const q = questionAbove(rows, block.start);
      return make('codex-usage', 'dialog', between(rows, usage, (q?.row ?? usage) + 1).split('\n').join(' '), block, {}, excerptOf(rows, usage, block.end), 'shortcuts');
    }
    const rate = find(/Approaching rate limits/);
    if (rate >= 0 && block && block.start > rate) return make('codex-rate', 'dialog', between(rows, rate, block.start).split('\n').join(' '), block, {}, excerptOf(rows, rate, block.end));
    const trust = find(/Trust this folder\?/);
    if (trust >= 0 && block && block.start > trust) return make('codex-trust', 'dialog', 'Trust this folder?', block, {}, excerptOf(rows, trust - 2, block.end + 1));
    const qs = text.match(CODEX_QUESTIONS);
    if (qs) return make('codex-questions', 'unknown', `Codex asked ${qs[1]} question${qs[1] === '1' ? '' : 's'}. Answer them in the terminal (shift+←).`, null, {}, tail(rows, 15), undefined, false);
  }

  if (agent === 'antigravity') {
    const trust = find(/Do you trust the contents of this project\?/);
    if (trust >= 0) { const block = plainBlock(rows, trust); if (block) return make('agy-trust', 'dialog', rows[trust].trim(), block, {}, excerptOf(rows, trust - 2, block.end + 1)); }
    const block = numberedBlock(rows);
    if (block && AGY_APPROVAL.test(rows.slice(block.start, block.end + 1).join('\n'))) {
      const q = questionAbove(rows, block.start);
      const command = q ? between(rows, q.row + 1, block.start) : '';
      return make('agy-approval', 'command', q?.text || 'Antigravity asks for approval.', block, { command: command || undefined }, excerptOf(rows, q?.row ?? block.start, block.end));
    }
  }

  // any other numbered list with a highlight near the bottom blocks the agent the same way: show it, type nothing
  const block = numberedBlock(rows);
  if (block && block.selected >= 0 && rows.length - block.end <= 6 && /enter|esc\b|navigate|confirm|select/i.test(rows.slice(block.end + 1).join('\n'))) {
    const q = questionAbove(rows, block.start);
    return make(`${agent}-unknown`, 'unknown', q?.text || 'The agent shows a list of choices.', block, {}, tail(rows, 15), undefined, false);
  }
  return null;
}
