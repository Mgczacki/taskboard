import { createHash } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { MailStore, type MailFile, type Message } from './store.ts';
import { SlackClient, SLACK_APP_ID } from './slack.ts';
import { MAX_FILE, receiveBytes, verifyFile } from './files.ts';

export const PREFIX = '[Taskboard message v1]\n';
export const FILE_PREFIX = '[Taskboard message v2]\n';
const INBOX_SCAN_LIMIT = 25;
const SETUP_URL = 'https://github.com/Mgczacki/taskboard/blob/master/SETUP.md';
export function encodeMessage(m: Message) {
  const summary = messageSummary(m);
  if (!m.files?.length) return `${summary}\n${PREFIX}` + JSON.stringify({ id: m.id, subject: m.subject, body: m.body });
  return `${summary}\n${FILE_PREFIX}` + JSON.stringify({ id: m.id, subject: m.subject, body: m.files.some(f => f.longBody) ? 'Full text is in the attached file.' : m.body,
    files: m.files.map(f => ({ id: f.slackId, name: f.name, size: f.size, hash: f.hash, longBody: !!f.longBody })) });
}
function messageSummary(m: Message) {
  const subject = m.subject.replace(/\s+/g, ' ').trim().slice(0, 100);
  return `Taskboard message: ${subject}. Open Taskboard Inbox to read.`;
}
function messageBlocks(m: Message) {
  const body = m.files?.some(f => f.longBody) ? 'Full text is in the attached file.' : m.body;
  const preview = body.length > 2500 ? `${body.slice(0, 2500)}\nOpen Taskboard Inbox for the full message.` : body;
  return JSON.stringify([
    { type: 'section', text: { type: 'plain_text', text: `${messageSummary(m)}\n${preview}` }, expand: false },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `New to Taskboard? <${SETUP_URL}|Get Taskboard>` }] },
  ]);
}
export function decodeMessage(text: unknown): { id: string; subject: string; body: string; files?: { id: string; name: string; size: number; hash: string; longBody?: boolean }[] } | null {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 40000) return null;
  const wire = text.startsWith('Taskboard message: ') ? text.slice(text.indexOf('\n') + 1) : text;
  if (!wire.startsWith(PREFIX) && !wire.startsWith(FILE_PREFIX)) return null;
  try {
    const hasFiles = wire.startsWith(FILE_PREFIX);
    const m = JSON.parse(wire.slice(hasFiles ? FILE_PREFIX.length : PREFIX.length));
    if (typeof m.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(m.id) || typeof m.subject !== 'string' || typeof m.body !== 'string') return null;
    if (hasFiles && (!Array.isArray(m.files) || m.files.length < 1 || m.files.length > 5 || m.files.some((f: any) => !/^F[A-Z0-9]+$/.test(f.id) || typeof f.name !== 'string' || !Number.isInteger(f.size) || f.size < 1 || f.size > MAX_FILE || !/^[a-f0-9]{64}$/.test(f.hash)))) return null;
    return m;
  } catch { return null; }
}
export class MailService {
  private syncing = false;
  private lastInboxScanAt = 0;
  private directory?: { user: string; expires: number; people: { user: string; name: string; realName?: string; image?: string }[] };
  error = '';
  constructor(readonly store: MailStore, readonly slack: SlackClient) {}

  async listPeople() {
    const identity = this.slack.identity(); if (!identity) throw new Error('Connect Slack first');
    if (this.directory?.user === identity.user && this.directory.expires > Date.now()) return this.directory.people;
    const people: { user: string; name: string; realName?: string; image?: string }[] = [];
    let cursor = '';
    do {
      const page = await this.slack.call('users.list', { limit: '200', ...(cursor ? { cursor } : {}) });
      if (this.slack.identity()?.user !== identity.user) throw new Error('Connection changed while loading people');
      for (const person of page.members || []) {
        if (!person.id || person.deleted || person.is_bot || person.is_app_user || person.id === identity.user) continue;
        if (person.team_id !== identity.team && !person.teams?.includes(identity.team)) continue;
        const name = String(person.profile?.display_name || person.real_name || person.name || person.id);
        const realName = String(person.real_name || person.profile?.real_name || '');
        people.push({ user: person.id, name, ...(realName && realName !== name ? { realName } : {}), image: person.profile?.image_48 });
      }
      cursor = page.response_metadata?.next_cursor || '';
    } while (cursor);
    people.sort((a, b) => a.name.localeCompare(b.name) || a.user.localeCompare(b.user));
    this.directory = { user: identity.user, expires: Date.now() + 300_000, people };
    return people;
  }

  async validateRecipient(id: string) {
    const identity = this.slack.identity(); if (!identity) throw new Error('Connect Slack first');
    if (!/^[UW][A-Z0-9]+$/.test(id) || id === identity.user) throw new Error('Choose another Slack workspace member');
    const info = await this.slack.call('users.info', { user: id });
    const member = info.user;
    if (this.slack.identity()?.user !== identity.user) throw new Error('Connection changed while checking the recipient');
    if (!member || member.id !== id || member.deleted || member.is_bot || member.is_app_user ||
        member.team_id !== identity.team && !member.teams?.includes(identity.team)) throw new Error('Choose an active person in this workspace');
    return member;
  }

  private async receiveEvent(event: any, channel: string, sender: string, identity: { user: string; team: string }) {
    if (event.user !== sender || event.subtype || (event.bot_id && event.app_id !== SLACK_APP_ID)) return;
    const parsed = decodeMessage(event.text); if (!parsed) return;
    const id = createHash('sha256').update(`${identity.team}:${channel}:${event.ts}`).digest('hex');
    if (this.store.read().messages.some(m => m.id === id)) return;
    const files: MailFile[] = [];
    try {
      for (const f of parsed.files || []) {
        const bytes = await this.slack.download(f.id, channel, sender, MAX_FILE);
        const received = receiveBytes(bytes, f.name, f.hash);
        received.slackId = f.id; received.longBody = !!f.longBody;
        files.push(received);
      }
      const longFile = files.find(f => f.longBody);
      if (files.filter(f => f.longBody).length > 1) throw new Error('Message contains more than one long text file');
      const body = longFile ? new TextDecoder('utf-8', { fatal: true }).decode(verifyFile(longFile)) : parsed.body;
      if (this.slack.identity()?.user !== identity.user) throw new Error('Connection changed during synchronization');
      this.store.add({ id, direction: 'inbox', source: 'slack', from: sender, to: identity.user, subject: parsed.subject, body, files, slackTs: event.ts, slackChannel: channel });
    } catch (e) {
      for (const file of files) { try { unlinkSync(file.path); } catch { /* The next retry checks stored metadata. */ } }
      if ((e as Error).message.startsWith('Invalid ')) return;
      throw e;
    }
  }

  async sync() {
    if (this.syncing || !this.slack.identity() || Date.now() - this.lastInboxScanAt < 60_000) return;
    this.syncing = true;
    this.lastInboxScanAt = Date.now();
    try {
      const identity = this.slack.identity()!;
      const conversations: any[] = [];
      let listCursor = '';
      do {
        const list = await this.slack.call('conversations.list', { types: 'im', limit: '200', ...(listCursor ? { cursor: listCursor } : {}) });
        if (this.slack.identity()?.user !== identity.user) throw new Error('Connection changed during synchronization');
        conversations.push(...(list.channels || []));
        listCursor = list.response_metadata?.next_cursor || '';
      } while (listCursor);
      const saved = this.store.read();
      const cursors = saved.messageCursors || {};
      const scans = saved.messageScans || {};
      const recent = saved.recentScans || {};
      const candidates = conversations.filter(conversation => {
        if (!conversation.id || !conversation.user || conversation.user === identity.user || conversation.is_user_deleted) return false;
        const oldest = Number(cursors[conversation.id] || 0), updated = Number(conversation.updated || 0);
        return !!recent[conversation.id] || !!scans[conversation.id] || !oldest || !updated || updated + 5 >= oldest;
      }).sort((a, b) => {
        const priority = (c: any) => {
          const oldest = Number(cursors[c.id] || 0), updated = Number(c.updated || 0);
          return recent[c.id] ? 4 : oldest && updated && updated + 5 >= oldest ? 3 : !oldest ? 2 : scans[c.id] ? 1 : 0;
        };
        return priority(b) - priority(a) || (scans[a.id] && scans[b.id] ? scans[a.id].lastPageAt - scans[b.id].lastPageAt : 0)
          || Number(b.updated || 0) - Number(a.updated || 0)
          || Number(cursors[a.id] || 0) - Number(cursors[b.id] || 0);
      });
      for (const conversation of candidates.slice(0, INBOX_SCAN_LIMIT)) {
        const channel = conversation.id;
        const head = cursors[channel];
        const stored = this.store.read();
        let kind: 'recent' | 'backfill' | 'initial';
        if (stored.recentScans?.[channel] || head && conversation.updated && Number(conversation.updated) + 5 >= Number(head)) kind = 'recent';
        else if (stored.messageScans?.[channel]) kind = 'backfill';
        else kind = head ? 'recent' : 'initial';
        const scan = kind === 'recent' ? stored.recentScans?.[channel] : kind === 'backfill' ? stored.messageScans?.[channel] : undefined;
        const pageState = scan || { oldest: kind === 'initial' ? '0' : head || '0', latest: (Date.now() / 1000).toFixed(6), cursor: '', lastPageAt: 0 };
        let page: any;
        try {
          page = await this.slack.call('conversations.history', { channel, oldest: pageState.oldest, latest: pageState.latest, inclusive: 'true', limit: '100', ...(pageState.cursor ? { cursor: pageState.cursor } : {}) });
        } catch (e) {
          if (/^Slack: (channel_not_found|not_in_channel|access_denied)$/.test((e as Error).message)) {
            this.store.change(data => {
              data.messageCursors ||= {}; data.messageCursors[channel] = String(Math.max(Number(data.messageCursors[channel] || 0), Number(pageState.latest)));
              if (data.messageScans) delete data.messageScans[channel];
              if (data.recentScans) delete data.recentScans[channel];
            });
            continue;
          }
          throw e;
        }
        if (this.slack.identity()?.user !== identity.user) throw new Error('Connection changed during synchronization');
        for (const event of page.messages || []) await this.receiveEvent(event, channel, conversation.user, identity);
        const next = page.response_metadata?.next_cursor || '';
        if (page.has_more && !next) throw new Error('Slack returned incomplete history. Retry synchronization.');
        this.store.change(data => {
          if (kind === 'initial') {
            data.messageCursors ||= {}; data.messageCursors[channel] = pageState.latest;
          }
          if (kind === 'initial' || kind === 'backfill') {
            data.messageScans ||= {};
            if (next) data.messageScans[channel] = { ...pageState, cursor: next, lastPageAt: Date.now() };
            else delete data.messageScans[channel];
          } else {
            data.recentScans ||= {};
            if (next) data.recentScans[channel] = { ...pageState, cursor: next, lastPageAt: Date.now() };
            else { data.messageCursors ||= {}; data.messageCursors[channel] = pageState.latest; delete data.recentScans[channel]; }
          }
        });
      }
      this.error = '';
    } catch (e) { this.error = (e as Error).message; throw e; }
    finally { this.syncing = false; }
  }

  async send(id: string) {
    const identity = this.slack.identity(); if (!identity) throw new Error('Connect Slack first');
    const m = this.store.get(id);
    if (m.direction !== 'outbox' || !m.approval || m.approval.hash !== m.hash || m.dismissedAt || m.rejectedAt) throw new Error('Approve this outbox message before sending');
    if (m.from !== identity.user) throw new Error('This draft belongs to a different Slack account');
    if (!m.review || m.review.verdict === 'quarantine') throw new Error('The message has not passed review');
    if (m.sentAt) return m;
    if (m.sending) throw new Error('Delivery is uncertain. Check the Slack conversation before retrying.');
    if (m.files?.some(f => !f.review || f.review.verdict === 'quarantine')) throw new Error('Files must pass controller review before sending');
    if (m.files?.some(f => f.review?.verdict === 'action-request' && m.approval?.by !== 'user')) throw new Error('Files with action requests need user approval');
    if (Buffer.byteLength(encodeMessage(m)) > 39000 && !m.files?.some(f => f.longBody)) throw new Error('The encoded message is too large for Slack');
    const bytes = (m.files || []).map(verifyFile);
    await this.validateRecipient(m.to);
    const conversation = await this.slack.call('conversations.open', { users: m.to });
    const channel = conversation.channel?.id; if (!/^D[A-Z0-9]+$/.test(channel || '')) throw new Error('Slack did not return a direct conversation');
    if (this.slack.identity()?.user !== identity.user) throw new Error('Connection changed before sending');
    this.store.update(id, x => { x.sending = true; x.sendStartedAt = new Date().toISOString(); delete x.error; });
    try {
      for (const [index, f] of (m.files || []).entries()) {
        const slackId = await this.slack.upload(f.name, bytes[index], channel);
        this.store.update(id, x => { const file = x.files?.find(x => x.id === f.id); if (file) file.slackId = slackId; });
      }
      const sent = this.store.get(id);
      const result = await this.slack.call('chat.postMessage', { channel, text: encodeMessage(sent), blocks: messageBlocks(sent), mrkdwn: 'false', unfurl_links: 'false', unfurl_media: 'false', parse: 'none', client_msg_id: m.id });
      if (!result.ts) throw new Error('Slack did not confirm delivery');
      return this.store.update(id, x => { x.sentAt = new Date().toISOString(); x.slackTs = result.ts; x.slackChannel = channel; x.sending = false; });
    } catch {
      this.store.update(id, x => { x.error = 'Slack did not confirm delivery. Check the conversation before retrying.'; });
      throw new Error('Delivery is uncertain. Check Slack before retrying.');
    }
  }
}
