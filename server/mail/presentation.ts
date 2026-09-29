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

export function needsBodyFile(body: string) {
  return escapeSlack(body).length > BODY_SECTION_LIMIT;
}

export function buildMessageBlocks(m: Message, senderName: string, machineName: string, proposer: string) {
  const sender = short(escapeSlack(senderName || m.from), 80);
  const machine = short(escapeSlack(machineName), 40);
  const proposedBy = short(escapeSlack(proposer), 110);
  const title = short(escapeSlack(m.subject), 145);
  const created = Number.isNaN(Date.parse(m.created)) ? m.created : new Date(m.created).toISOString().replace('T', ' ').replace(/:\d{2}\.\d{3}Z$/, ' UTC');
  const longFile = m.files?.find(file => file.longBody);
  const escaped = escapeSlack(m.body);
  const preview = escapeSlack(Array.from(m.body).slice(0, 400).join(''));
  const body = longFile
    ? `${preview}…\n\nRead the full text in ${short(escapeSlack(longFile.name), 80)} sent above.`
    : escaped.length > BODY_SECTION_LIMIT
      ? `${preview}…\n\nOpen Taskboard Inbox to read the full message.`
      : escaped;
  return [
    { type: 'header', text: { type: 'plain_text', text: title } },
    { type: 'context', elements: [{ type: 'plain_text', text: `Sent automatically by Taskboard · ${sender} · ${proposedBy}` }] },
    { type: 'context', elements: [{ type: 'plain_text', text: `${machine} · ${created} · ID ${m.id}` }] },
    { type: 'divider' },
    { type: 'section', text: { type: 'plain_text', text: body }, expand: false },
    { type: 'divider' },
    { type: 'context', elements: [
      { type: 'plain_text', text: `To reply, send a new Taskboard message to ${sender}. Slack replies do not enter Taskboard Inbox.` },
      { type: 'mrkdwn', text: `<${SETUP_URL}|Get Taskboard>` },
    ] },
  ];
}
