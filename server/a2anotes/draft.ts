// A message body from sections, for `tb mail draft --context --ask --found --by --links`. The sections give a reader
// without task context the reason, the facts, the request, and the date.
export interface DraftSections { context?: unknown; found?: unknown; ask?: unknown; by?: unknown; links?: unknown }

function text(value: unknown, limit: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error(`Give the ${label} as text.`);
  return value.trim();
}
export function draftBody(input: DraftSections & { body?: unknown }): string {
  if (input.body !== undefined && input.body !== null && input.body !== '') return text(input.body, 20_000, 'message body');
  const context = text(input.context, 4000, 'reason for the message');
  const ask = text(input.ask, 4000, 'request');
  const part = (heading: string, value: unknown) => typeof value === 'string' && value.trim() ? `${heading}\n${value.trim()}` : '';
  const links = typeof input.links === 'string' ? input.links.split(/\n|,/).map(s => s.trim()).filter(Boolean) : input.links;
  if (links !== undefined && (!Array.isArray(links) || links.some(link => typeof link !== 'string' || !/^https:\/\//.test(link)))) throw new Error('Links must use HTTPS.');
  return text([part('Why you are getting this', context), part('What we found', input.found), part('What we need from you', ask), part('By when', input.by),
    links?.length ? `Links\n${links.map((link: string) => `- ${link}`).join('\n')}` : ''].filter(Boolean).join('\n\n'), 20_000, 'message body');
}

// The body without the sentences that the message check flagged (for "Remove flagged text" on a card).
export function removeFlags(body: string, flags: { start: number; end: number }[]): string {
  let result = body;
  for (const flag of [...flags].filter(f => f.end > f.start).sort((a, b) => b.start - a.start)) result = result.slice(0, flag.start) + result.slice(flag.end);
  return result.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
