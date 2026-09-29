import { createHash, randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { MailStore, type MailFile, type Message } from './store.ts';
import { SlackClient, SLACK_APP_ID } from './slack.ts';
import { MAX_FILE, receiveBytes, verifyFile } from './files.ts';

export const PREFIX = '[Taskboard message v1]\n';
export const FILE_PREFIX = '[Taskboard message v2]\n';
export const CONTACT_PREFIX = '[Taskboard contact v1]\n';
const CONTACT_REQUEST_SUMMARY = 'Taskboard contact request. Open Taskboard Inbox to respond.';
const CONTACT_UPDATE_SUMMARY = 'Taskboard contact update. Open Taskboard Inbox.';
const compactBlocks = (summary: string) => JSON.stringify([{ type: 'section', text: { type: 'plain_text', text: summary } }]);
type ContactEvent = { type: 'request' | 'accept' | 'decline' | 'remove'; id: string };
function encodeContact(event: ContactEvent) {
  const summary = event.type === 'request' ? CONTACT_REQUEST_SUMMARY : CONTACT_UPDATE_SUMMARY;
  return `${summary}\n${CONTACT_PREFIX}${JSON.stringify(event)}`;
}
export function decodeContact(text: unknown): ContactEvent | null {
  if (typeof text !== 'string' || text.length > 200) return null;
  const wire = text.startsWith(`${CONTACT_REQUEST_SUMMARY}\n`) ? text.slice(CONTACT_REQUEST_SUMMARY.length + 1)
    : text.startsWith(`${CONTACT_UPDATE_SUMMARY}\n`) ? text.slice(CONTACT_UPDATE_SUMMARY.length + 1) : text;
  if (!wire.startsWith(CONTACT_PREFIX)) return null;
  try {
    const value = JSON.parse(wire.slice(CONTACT_PREFIX.length));
    return ['request', 'accept', 'decline', 'remove'].includes(value.type) && /^[a-f0-9-]{36}$/.test(value.id) ? value : null;
  } catch { return null; }
}
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
  return JSON.stringify([{ type: 'section', text: { type: 'plain_text', text: `${messageSummary(m)}\n${preview}` }, expand: false }]);
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
  error = '';
  constructor(readonly store: MailStore, readonly slack: SlackClient) {}
  async searchPeople(query: string) {
    if (query.trim().length < 2 || query.length > 100) throw new Error('Enter at least two name characters');
    const identity = this.slack.identity(); if (!identity) throw new Error('Connect Slack first');
    const matches: { user: string; name: string; image?: string }[] = [];
    let cursor = '';
    do {
      const page = await this.slack.call('users.list', { limit: '200', ...(cursor ? { cursor } : {}) });
      for (const person of page.members || []) {
        if (person.deleted || person.is_bot || person.is_app_user || person.id === identity.user || person.team_id !== identity.team) continue;
        const name = String(person.profile?.display_name || person.real_name || person.name || '');
        if (name.toLowerCase().includes(query.trim().toLowerCase())) matches.push({ user: person.id, name, image: person.profile?.image_48 });
      }
      cursor = page.response_metadata?.next_cursor || '';
    } while (cursor);
    return matches.slice(0, 20);
  }
  async requestContact(id: string) {
    if (!/^[UW][A-Z0-9]+$/.test(id)) throw new Error('Choose a Slack workspace member');
    const identity = this.slack.identity(); if (!identity || id === identity.user) throw new Error('Choose another workspace member');
    const existing = this.store.read().contacts.find(c => c.user === id);
    if (existing?.status === 'active' || existing?.status === 'requested') throw new Error('This person is already a contact or has a pending request');
    const info = await this.slack.call('users.info', { user: id });
    if (!info.user || info.user.deleted || info.user.is_bot || info.user.team_id !== identity.team) throw new Error('Choose an active person in this workspace');
    const conversation = await this.slack.call('conversations.open', { users: id });
    const channel = conversation.channel?.id; if (!channel) throw new Error('Slack did not return a direct conversation');
    const requestId = randomUUID();
    await this.slack.call('chat.postMessage', { channel, text: encodeContact({ type: 'request', id: requestId }), blocks: compactBlocks(CONTACT_REQUEST_SUMMARY), mrkdwn: 'false', unfurl_links: 'false' });
    this.store.change(data => {
      data.contacts = data.contacts.filter(c => c.user !== id);
      data.contacts.push({ user: id, name: info.user.real_name || info.user.name || id, channel, oldest: String(Date.now() / 1000), status: 'requested', requestId });
    });
  }
  async answerContact(id: string, accept: boolean) {
    const pending = (this.store.read().requests || []).find(r => r.user === id);
    if (!pending) throw new Error('No pending contact request');
    const result = await this.slack.call('chat.postMessage', { channel: pending.channel, text: encodeContact({ type: accept ? 'accept' : 'decline', id: pending.requestId }), blocks: compactBlocks(CONTACT_UPDATE_SUMMARY), mrkdwn: 'false', unfurl_links: 'false' });
    if (!result.ts) throw new Error('Slack did not confirm the contact response');
    this.store.change(data => {
      data.requests = (data.requests || []).filter(r => r.user !== id);
      if (accept) {
        data.contacts = data.contacts.filter(c => c.user !== id);
        data.contacts.push({ user: id, name: pending.name, channel: pending.channel, oldest: String(Date.now() / 1000), status: 'active', requestId: pending.requestId });
      }
    });
  }
  async removeContact(id: string) {
    const contact = this.store.read().contacts.find(c => c.user === id);
    if (!contact) return;
    this.store.change(data => { data.contacts = data.contacts.filter(c => c.user !== id); });
    try { await this.slack.call('chat.postMessage', { channel: contact.channel, text: encodeContact({ type: 'remove', id: contact.requestId || randomUUID() }), blocks: compactBlocks(CONTACT_UPDATE_SUMMARY), mrkdwn: 'false' }); } catch { /* Local removal takes effect even when Slack is unavailable. */ }
  }
  private async scanRequests(identity: { user: string; team: string }) {
    let listCursor = '';
    do {
      const list = await this.slack.call('conversations.list', { types: 'im', limit: '200', ...(listCursor ? { cursor: listCursor } : {}) });
      for (const conversation of list.channels || []) {
        if (!conversation.id || !conversation.user || conversation.user === identity.user) continue;
        const oldest = this.store.read().requestCursors?.[conversation.id] || '0';
        const latest = (Date.now() / 1000).toFixed(6);
        let cursor = '';
        do {
          const page = await this.slack.call('conversations.history', { channel: conversation.id, oldest, latest, inclusive: 'true', limit: '100', ...(cursor ? { cursor } : {}) });
          if (this.slack.identity()?.user !== identity.user) throw new Error('Connection changed during synchronization');
          for (const event of page.messages || []) {
            if (event.user !== conversation.user || event.subtype || (event.bot_id && event.app_id !== SLACK_APP_ID)) continue;
            const marker = decodeContact(event.text); if (!marker) continue;
            this.store.change(data => {
              data.requests ||= [];
              const contact = data.contacts.find(c => c.user === event.user);
              if (marker.type === 'request') {
                if (contact?.status === 'active' || data.requests.some(r => r.user === event.user && r.requestId === marker.id)) return;
                data.requests = data.requests.filter(r => r.user !== event.user);
                data.requests.push({ user: event.user, name: event.user, channel: conversation.id, requestId: marker.id, at: new Date(Number(event.ts) * 1000).toISOString() });
              } else if (contact?.requestId === marker.id && contact.channel === conversation.id) {
                if (marker.type === 'accept' && contact.status === 'requested') { contact.status = 'active'; contact.oldest = event.ts; }
                if (marker.type === 'decline' || marker.type === 'remove') data.contacts = data.contacts.filter(c => c.user !== event.user);
              }
            });
          }
          cursor = page.response_metadata?.next_cursor || '';
          if (page.has_more && !cursor) throw new Error('Slack returned incomplete history. Retry synchronization.');
        } while (cursor);
        this.store.change(data => { data.requestCursors ||= {}; data.requestCursors[conversation.id] = latest; });
      }
      listCursor = list.response_metadata?.next_cursor || '';
    } while (listCursor);
    const unknown = (this.store.read().requests || []).filter(r => r.name === r.user);
    for (const request of unknown) {
      const info = await this.slack.call('users.info', { user: request.user });
      this.store.change(d => {
        const r = d.requests?.find(x => x.user === request.user); if (!r) return;
        if (!info.user || info.user.deleted || info.user.is_bot || info.user.team_id !== identity.team) d.requests = d.requests?.filter(x => x.user !== request.user);
        else r.name = info.user.real_name || info.user.name || r.user;
      });
    }
  }
  async sync() {
    if (this.syncing || !this.slack.identity()) return;
    this.syncing = true;
    try {
      const identity = this.slack.identity()!;
      await this.scanRequests(identity);
      for (const contact of this.store.read().contacts) {
        if (contact.status !== 'active') continue;
        const latest = (Date.now() / 1000).toFixed(6);
        let cursor = '';
        do {
          const page = await this.slack.call('conversations.history', { channel: contact.channel, oldest: contact.oldest, latest, inclusive: 'true', limit: '100', ...(cursor ? { cursor } : {}) });
          if (this.slack.identity()?.user !== identity.user || !this.store.read().contacts.some(c => c.user === contact.user)) throw new Error('Connection changed during synchronization');
          for (const event of page.messages || []) {
            if (event.user !== contact.user || event.subtype || (event.bot_id && event.app_id !== SLACK_APP_ID)) continue;
            const parsed = decodeMessage(event.text); if (!parsed) continue;
            const id = createHash('sha256').update(`${identity.team}:${contact.channel}:${event.ts}`).digest('hex');
            const files: MailFile[] = [];
            try {
              if (this.store.read().messages.some(m => m.id === id)) continue;
              for (const f of parsed.files || []) {
                const bytes = await this.slack.download(f.id, contact.channel, event.user, MAX_FILE);
                const received = receiveBytes(bytes, f.name, f.hash);
                received.slackId = f.id; received.longBody = !!f.longBody;
                files.push(received);
              }
              const longFile = files.find(f => f.longBody);
              if (files.filter(f => f.longBody).length > 1) throw new Error('Message contains more than one long text file');
              const body = longFile ? new TextDecoder('utf-8', { fatal: true }).decode(verifyFile(longFile)) : parsed.body;
              this.store.add({ id, direction: 'inbox', source: 'slack', from: event.user, to: identity.user, subject: parsed.subject, body, files, slackTs: event.ts, slackChannel: contact.channel });
            }
            catch (e) { for (const file of files) { try { unlinkSync(file.path); } catch { /* The next retry checks stored metadata. */ } } if ((e as Error).message.startsWith('Invalid ')) continue; throw e; }
          }
          cursor = page.response_metadata?.next_cursor || '';
          if (page.has_more && !cursor) throw new Error('Slack returned incomplete history. Retry synchronization.');
        } while (cursor);
        this.store.change(data => { const c = data.contacts.find(x => x.user === contact.user); if (c) c.oldest = latest; });
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
    const contact = this.store.read().contacts.find(c => c.user === m.to);
    if (!contact || contact.status !== 'active') throw new Error('Wait for the recipient to accept your contact request');
    if (m.files?.some(f => !f.review || f.review.verdict === 'quarantine')) throw new Error('Files must pass controller review before sending');
    if (m.files?.some(f => f.review?.verdict === 'action-request' && m.approval?.by !== 'user')) throw new Error('Files with action requests need user approval');
    if (Buffer.byteLength(encodeMessage(m)) > 39000 && !m.files?.some(f => f.longBody)) throw new Error('The encoded message is too large for Slack');
    const bytes = (m.files || []).map(verifyFile);
    this.store.update(id, x => { x.sending = true; x.sendStartedAt = new Date().toISOString(); delete x.error; });
    try {
      for (const [index, f] of (m.files || []).entries()) {
        const slackId = await this.slack.upload(f.name, bytes[index], contact.channel);
        this.store.update(id, x => { const file = x.files?.find(x => x.id === f.id); if (file) file.slackId = slackId; });
      }
      const sent = this.store.get(id);
      const result = await this.slack.call('chat.postMessage', { channel: contact.channel, text: encodeMessage(sent), blocks: messageBlocks(sent), mrkdwn: 'false', unfurl_links: 'false', unfurl_media: 'false', parse: 'none', client_msg_id: m.id });
      if (!result.ts) throw new Error('Slack did not confirm delivery');
      return this.store.update(id, x => { x.sentAt = new Date().toISOString(); x.slackTs = result.ts; x.slackChannel = contact.channel; x.sending = false; });
    } catch {
      this.store.update(id, x => { x.error = 'Slack did not confirm delivery. Check the conversation before retrying.'; });
      throw new Error('Delivery is uncertain. Check Slack before retrying.');
    }
  }
}
