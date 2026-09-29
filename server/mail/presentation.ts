import { marked } from 'marked';
import type { Message } from './store.ts';

export const BODY_SECTION_LIMIT = 2500;
const SETUP_URL = 'https://github.com/Mgczacki/taskboard/blob/master/SETUP.md';

export function escapeSlack(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function short(text: string, limit: number) {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length <= limit ? chars.join('') : `${chars.slice(0, limit - 1).join('')}…`;
}

// Slack can turn plain @names into mentions. Break that syntax without changing its visible text.
function safeSlackText(text: string) {
  return escapeSlack(text.replace(/@(?=[A-Za-z0-9_])/g, '@\u200b'));
}

function safeText(text: string) {
  return safeSlackText(text)
    .replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1');
}

function fenceLength(code: string, minimum: number) {
  let length = minimum;
  for (const match of code.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  return length;
}

function safeUrl(href: string) {
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return { href: url.href.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\[/g, '%5B').replace(/\]/g, '%5D'), host: url.host };
  } catch { return null; }
}

type Token = { type: string; text?: string; raw?: string; tokens?: Token[]; href?: string; lang?: string; depth?: number;
  ordered?: boolean; start?: number | string; items?: Token[]; task?: boolean; checked?: boolean;
  header?: { tokens: Token[] }[]; rows?: { tokens: Token[] }[][] };

function inline(tokens: Token[]): string {
  return tokens.map(token => {
    const children = token.tokens || [];
    switch (token.type) {
      case 'strong': return `**${inline(children)}**`;
      case 'em': return `*${inline(children)}*`;
      case 'del': return `~~${inline(children)}~~`;
      case 'codespan': {
        const code = safeSlackText(token.text || '');
        const fence = '`'.repeat(fenceLength(code, 1));
        return `${fence}${code}${fence}`;
      }
      case 'link':
      case 'image': {
        const label = token.text || '';
        const url = safeUrl(token.href || '');
        if (!url) return safeText(label || token.href || '');
        return `[${safeText(label)} (${safeText(url.host)})](${url.href})`;
      }
      case 'br': return '  \n';
      case 'html': return /^<br\s*\/?>$/i.test(token.raw || '') ? ', ' : safeText(token.raw || '');
      case 'escape': return safeText(token.text || '');
      case 'text': return children.length ? inline(children) : safeText(token.text || '');
      default: return safeText(token.text || token.raw || '');
    }
  }).join('');
}

function blocks(tokens: Token[]): string {
  return tokens.filter(token => token.type !== 'space').map(token => {
    switch (token.type) {
      case 'heading': return `${'#'.repeat(Math.min(token.depth || 1, 6))} ${inline(token.tokens || [])}`;
      case 'paragraph': return inline(token.tokens || []);
      case 'text': return token.tokens ? inline(token.tokens) : safeText(token.text || '');
      case 'hr': return '---';
      case 'code': {
        const code = safeSlackText(token.text || '');
        const fence = '`'.repeat(fenceLength(code, 3));
        const lang = /^[a-zA-Z0-9_+-]+$/.test(token.lang || '') ? token.lang : '';
        return `${fence}${lang}\n${code}\n${fence}`;
      }
      case 'blockquote': return blocks(token.tokens || []).split('\n').map(line => `> ${line}`).join('\n');
      case 'list': return (token.items || []).map((item, index) => {
        const marker = token.ordered ? `${Number(token.start || 1) + index}.` : '-';
        const check = item.task ? `[${item.checked ? 'x' : ' '}] ` : '';
        const content = blocks(item.tokens || []).replace(/\n\n/g, '\n');
        return `${marker} ${check}${content.replace(/\n/g, '\n  ')}`;
      }).join('\n');
      case 'table': {
        const row = (cells: { tokens: Token[] }[]) => `| ${cells.map(cell => inline(cell.tokens).replace(/\n/g, ' ')).join(' | ')} |`;
        return [row(token.header || []), `| ${(token.header || []).map(() => '---').join(' | ')} |`, ...(token.rows || []).map(row)].join('\n');
      }
      default: return safeText(token.text || token.raw || '');
    }
  }).join('\n\n');
}

export function renderSlackMarkdown(body: string) {
  return blocks(marked.lexer(body) as Token[]);
}

export function needsBodyFile(body: string) {
  return renderSlackMarkdown(body).length > BODY_SECTION_LIMIT;
}

function preview(body: string, suffix: string) {
  const max = BODY_SECTION_LIMIT - suffix.length - 6;
  const parts = (marked.lexer(body) as Token[]).filter(token => token.type !== 'space');
  const result: string[] = [];
  for (const part of parts) {
    const next = blocks([part]);
    if (result.join('\n\n').length + next.length + (result.length ? 2 : 0) > max) break;
    result.push(next);
  }
  if (!result.length) {
    let excerpt = '';
    for (const char of body) {
      const next = safeText(char === '@' ? '@\u200b' : char);
      if (excerpt.length + next.length > max) break;
      excerpt += next;
    }
    result.push(excerpt);
  }
  return `${result.join('\n\n')}\n\n... ${suffix}`;
}

export function buildMessageBlocks(m: Message, senderName: string, machineName: string, proposer: string) {
  const sender = short(escapeSlack(senderName || m.from), 80);
  const machine = short(escapeSlack(machineName), 40);
  const proposedBy = short(escapeSlack(proposer), 110);
  const title = short(escapeSlack(m.subject), 145);
  const created = Number.isNaN(Date.parse(m.created)) ? m.created : new Date(m.created).toISOString().replace('T', ' ').replace(/:\d{2}\.\d{3}Z$/, ' UTC');
  const longFile = m.files?.find(file => file.longBody);
  const rendered = renderSlackMarkdown(m.body);
  const body = longFile
    ? preview(m.body, `Read the full text in ${short(escapeSlack(longFile.name), 80)} sent above.`)
    : rendered.length > BODY_SECTION_LIMIT
      ? preview(m.body, 'Open Taskboard Inbox to read the full message.')
      : rendered;
  return [
    { type: 'header', text: { type: 'plain_text', text: title } },
    { type: 'context', elements: [{ type: 'plain_text', text: `Sent automatically by Taskboard · ${sender} · ${proposedBy}` }] },
    { type: 'context', elements: [{ type: 'plain_text', text: `${machine} · ${created} · ID ${m.id}` }] },
    { type: 'divider' },
    { type: 'markdown', text: body },
    { type: 'divider' },
    { type: 'context', elements: [
      { type: 'plain_text', text: `To reply, send a new Taskboard message to ${sender}. Slack replies do not enter Taskboard Inbox.` },
      { type: 'mrkdwn', text: `<${SETUP_URL}|Get Taskboard>` },
    ] },
  ];
}
