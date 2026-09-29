import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = 'web/src';
const css = readFileSync(join(root, 'mockup.css'), 'utf8');
const errors = [];
const controls = ['button', 'input', 'select', 'textarea', 'summary', 'details', 'a', 'table', 'ul', 'ol', 'pre', 'code'];
const base = {
  button: ':where(button)', input: ':where(input:not(', select: ':where(input:not(',
  textarea: ':where(input:not(', summary: ':where(summary)', details: ':where(details)',
  a: ':where(summary:hover, a:hover)', table: ':where(table)',
  ul: ':where(ul, ol)', ol: ':where(ul, ol)', pre: ':where(pre)', code: 'code {'
};
for (const tag of controls) if (!css.includes(base[tag])) errors.push(`mockup.css: missing base style for <${tag}>`);
for (const state of [':hover', ':focus-visible', ':disabled']) {
  if (!css.includes(state)) errors.push(`mockup.css: missing ${state} state`);
}
if (!css.includes('::-webkit-scrollbar-thumb { background: var(--line2)')) errors.push('mockup.css: scrollbar must use a theme variable');

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.tsx') ? [join(dir, entry.name)] : []);
}

let count = 0;
for (const path of files(root)) {
  const source = readFileSync(path, 'utf8');
  for (const match of source.matchAll(/<(button|input|select|textarea|summary|details|a|table|ul|ol|pre|code)\b([^>]*)/g)) {
    const [, tag, attributes] = match;
    count++;
    const line = source.slice(0, match.index).split('\n').length;
    const literal = attributes.match(/\bclassName="([^"]*)"/)?.[1].split(/\s+/) || [];
    if (path.endsWith('/Mail.tsx') && ['button', 'input', 'select', 'textarea'].includes(tag)) {
      const expected = tag === 'button' ? 'btn' : tag === 'input' && /\btype="checkbox"/.test(attributes) ? 'mail-checkbox' : 'mail-input';
      if (!literal.includes(expected)) errors.push(`${path}:${line}: <${tag}> needs ${expected}`);
    }
    if (path.endsWith('/Ask.tsx') && tag === 'button' && !literal.includes('btn')) errors.push(`${path}:${line}: Ask button needs btn`);
  }
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`Checked ${count} controls across all TSX files. Base styles and component classes are present.`);
