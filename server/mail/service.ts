import { createHash } from 'node:crypto';
import { MailStore, type Message } from './store.ts';
import { SlackClient, SLACK_APP_ID } from './slack.ts';

export const PREFIX = '[Taskboard message v1]\n';
export function encodeMessage(m: Message) { return PREFIX + JSON.stringify({ id: m.id, subject: m.subject, body: m.body }); }
export function decodeMessage(text: unknown): { id: string; subject: string; body: string } | null {
  if (typeof text !== 'string' || !text.startsWith(PREFIX) || Buffer.byteLength(text) > 40000) return null;
  try {
    const m = JSON.parse(text.slice(PREFIX.length));
    return typeof m.id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(m.id) && typeof m.subject === 'string' && typeof m.body === 'string' ? m : null;
  } catch { return null; }
}
export class MailService {
  private syncing = false;
  error = '';
  constructor(readonly store: MailStore, readonly slack: SlackClient) {}
  async sync() {
    if (this.syncing || !this.slack.identity()) return;
    this.syncing = true;
    try {
      const identity = this.slack.identity()!;
      for (const contact of this.store.read().contacts) {
        const latest = (Date.now() / 1000).toFixed(6);
        let cursor = '';
        do {
          const page = await this.slack.call('conversations.history', { channel: contact.channel, oldest: contact.oldest, latest, inclusive: 'true', limit: '100', ...(cursor ? { cursor } : {}) });
          if (this.slack.identity()?.user !== identity.user || !this.store.read().contacts.some(c => c.user === contact.user)) throw new Error('Connection changed during synchronization');
          for (const event of page.messages || []) {
            if (event.user !== contact.user || event.subtype || (event.bot_id && event.app_id !== SLACK_APP_ID)) continue;
            const parsed = decodeMessage(event.text); if (!parsed) continue;
            const id = createHash('sha256').update(`${identity.team}:${contact.channel}:${event.ts}`).digest('hex');
            try { this.store.add({ id, direction: 'inbox', source: 'slack', from: event.user, to: identity.user, subject: parsed.subject, body: parsed.body, slackTs: event.ts, slackChannel: contact.channel }); }
            catch (e) { if ((e as Error).message.startsWith('Invalid ')) continue; throw e; }
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
    if (!contact) throw new Error('Add the recipient as a contact first');
    if (Buffer.byteLength(encodeMessage(m)) > 39000) throw new Error('The encoded message is too large for Slack');
    this.store.update(id, x => { x.sending = true; x.sendStartedAt = new Date().toISOString(); delete x.error; });
    try {
      const result = await this.slack.call('chat.postMessage', { channel: contact.channel, text: encodeMessage(m), mrkdwn: 'false', unfurl_links: 'false', unfurl_media: 'false', parse: 'none', client_msg_id: m.id });
      if (!result.ts) throw new Error('Slack did not confirm delivery');
      return this.store.update(id, x => { x.sentAt = new Date().toISOString(); x.slackTs = result.ts; x.slackChannel = contact.channel; x.sending = false; });
    } catch {
      this.store.update(id, x => { x.error = 'Slack did not confirm delivery. Check the conversation before retrying.'; });
      throw new Error('Delivery is uncertain. Check Slack before retrying.');
    }
  }
}
