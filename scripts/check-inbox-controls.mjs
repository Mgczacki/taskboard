import { readFileSync } from 'node:fs';

const path = process.argv[2] || 'web/src/components/Mail.tsx';
const lines = readFileSync(path, 'utf8').split('\n');
const errors = [];

for (const [index, line] of lines.entries()) {
  for (const match of line.matchAll(/<(button|input|select|textarea)\b([^>]*)/g)) {
    const [, tag, attributes] = match;
    const classes = attributes.match(/^\s+className="([^"]*)"/)?.[1].split(/\s+/) || [];
    const expected = tag === 'button' ? 'btn' : tag === 'input' && /\btype="checkbox"/.test(attributes) ? 'mail-checkbox' : 'mail-input';
    if (!classes.includes(expected)) errors.push(`${path}:${index + 1}: <${tag}> needs className with ${expected}`);
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
}
