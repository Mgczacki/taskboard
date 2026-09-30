import { validText } from './store.ts';

export interface DraftSections { context?: unknown; found?: unknown; ask?: unknown; by?: unknown; links?: unknown }

export function draftBody(input: DraftSections & { body?: unknown }): string {
  if (input.body !== undefined) return validText(input.body, 262144, 'message body');
  const context = validText(input.context, 4000, 'reason for message').trim();
  const ask = validText(input.ask, 4000, 'request').trim();
  const part = (heading: string, value: unknown) => typeof value === 'string' && value.trim() ? `${heading}\n${value.trim()}` : '';
  const links = typeof input.links === 'string' ? input.links.split(/\n|,/).map(s => s.trim()).filter(Boolean) : input.links;
  if (links !== undefined && (!Array.isArray(links) || links.some(link => typeof link !== 'string' || !/^https:\/\//.test(link)))) throw new Error('Links must use HTTPS');
  const body = [part('Why you are getting this', context), part('What we found', input.found), part('What we need from you', ask), part('By when', input.by),
    links?.length ? `Links\n${links.map((link: string) => `- ${link}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
  return validText(body, 262144, 'message body');
}
