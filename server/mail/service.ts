import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MailStore, savePrivate, type MailFile, type Message } from './store.ts';
import { SlackClient, SLACK_APP_ID } from './slack.ts';
import { MAX_FILE, receiveBytes, verifyFile } from './files.ts';
import { buildMessageBlocks, escapeSlack } from './presentation.ts';
import * as tasks from '../store.ts';
import { hostname } from 'node:os';

export const PREFIX = '[Taskboard message v1]\n';
export const FILE_PREFIX = '[Taskboard message v2]\n';
export interface Person { user: string; name: string; realName: string; title: string; isBot: boolean; deleted: boolean; handle?: string; email?: string }
export class RecipientMatchError extends Error {
  constructor(message: string, readonly matches: Omit<Person, 'handle'>[], readonly hasMore: boolean) { super(message); }
}
const INBOX_SCAN_LIMIT = 25;
export function encodeMessage(m: Message, senderName = m.from) {
  const summary = messageSummary(m, senderName);
  if (!m.files?.length) return `${summary}\n${PREFIX}` + JSON.stringify({ id: m.id, subject: m.subject, body: m.body });
  return `${summary}\n${FILE_PREFIX}` + JSON.stringify({ id: m.id, subject: m.subject, body: m.files.some(f => f.longBody) ? 'Full text is in the attached file.' : m.body,
    files: m.files.map(f => ({ id: f.slackId, name: f.name, size: f.size, hash: f.hash, longBody: !!f.longBody })) });
}
function messageSummary(m: Message, senderName: string) {
  const subject = escapeSlack(m.subject.replace(/\s+/g, ' ').trim().slice(0, 100));
  const sender = escapeSlack(senderName.replace(/\s+/g, ' ').trim().slice(0, 80));
  return `Taskboard message: ${subject}. Sent automatically by Taskboard from ${sender}. Open Taskboard Inbox to read.`;
}
export function decodeMessage(text: unknown): { id: string; subject: string; body: string; files?: { id: string; name: string; size: number; hash: string; longBody?: boolean }[] } | null {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 40000) return null;
  if (!text.startsWith('Taskboard message: ') && !text.startsWith('[Taskboard message v')) return null;
  for (const match of text.matchAll(/\[Taskboard message v([12])\]\s+(?=\{)/g)) {
    try {
      const hasFiles = match[1] === '2';
      const m = JSON.parse(text.slice(match.index! + match[0].length));
      if (typeof m.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(m.id) || typeof m.subject !== 'string' || typeof m.body !== 'string') continue;
      if (hasFiles && (!Array.isArray(m.files) || m.files.length < 1 || m.files.length > 5 || m.files.some((f: any) => !/^F[A-Z0-9]+$/.test(f.id) || typeof f.name !== 'string' || !Number.isInteger(f.size) || f.size < 1 || f.size > MAX_FILE || !/^[a-f0-9]{64}$/.test(f.hash)))) continue;
      return m;
    } catch { /* A subject can contain the marker before the actual data. */ }
  }
  return null;
}
export class MailService {
  private syncing = false;
  private lastInboxScanAt = 0;
  private directory?: { user: string; team: string; expires: number; people: Person[] };
  private directoryLoading?: Promise<Person[]>;
  error = '';
  constructor(readonly store: MailStore, readonly slack: SlackClient, private machineName: () => string = () => process.env.TASKBOARD_MACHINE_NAME || hostname()) {}

  private scope(name: string) {
    const identity = this.slack.identity();
    if (!identity) throw new Error('Connect Slack first');
    if (identity.scopes && !identity.scopes.includes(name)) throw new Error(`Add Slack scope ${name}, then reconnect Slack`);
    return identity;
  }

  private async loadPeople() {
    const identity = this.scope('users:read');
    const file = join(dirname(this.store.file), 'mail-people-cache.json');
    if (this.directory?.user === identity.user && this.directory.team === identity.team && this.directory.expires > Date.now()) return this.directory.people;
    if (!this.directory && existsSync(file)) {
      try {
        const cached = JSON.parse(readFileSync(file, 'utf8'));
        if (cached.user === identity.user && cached.team === identity.team && cached.expires > Date.now() && Array.isArray(cached.people)) {
          this.directory = cached;
          return cached.people as Person[];
        }
      } catch { /* Refresh a damaged cache. */ }
    }
    if (this.directoryLoading) return this.directoryLoading;
    this.directoryLoading = this.fetchPeople(identity, file).finally(() => { this.directoryLoading = undefined; });
    return this.directoryLoading;
  }

  private async fetchPeople(identity: { user: string; team: string }, file: string) {
    const people: Person[] = [];
    let cursor = '';
    do {
      let page: any;
      try { page = await this.slack.call('users.list', { limit: '200', ...(cursor ? { cursor } : {}) }); }
      catch (error) { if (/missing_scope/.test((error as Error).message)) throw new Error('Add Slack scope users:read, then reconnect Slack'); throw error; }
      if (this.slack.identity()?.user !== identity.user) throw new Error('Connection changed while loading people');
      for (const member of page.members || []) {
        if (!member.id || member.team_id !== identity.team && !member.teams?.includes(identity.team)) continue;
        people.push({ user: String(member.id), name: String(member.profile?.display_name || member.real_name || member.name || member.id),
          realName: String(member.real_name || member.profile?.real_name || ''), title: String(member.profile?.title || ''),
          isBot: !!(member.is_bot || member.is_app_user), deleted: !!member.deleted,
          handle: String(member.name || ''), email: String(member.profile?.email || '') });
      }
      cursor = page.response_metadata?.next_cursor || '';
    } while (cursor);
    people.sort((a, b) => a.name.localeCompare(b.name) || a.user.localeCompare(b.user));
    this.directory = { user: identity.user, team: identity.team, expires: Date.now() + 300_000, people };
    savePrivate(file, this.directory);
    return people;
  }

  async searchPeople(raw: string) {
    const query = raw.trim();
    if (query.length < 2 || query.length > 200) throw new Error('Search text must have 2 to 200 characters');
    const identity = this.slack.identity(); if (!identity) throw new Error('Connect Slack first');
    const exactEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query);
    if (exactEmail) {
      this.scope('users:read.email');
      let member: any;
      try { member = (await this.slack.call('users.lookupByEmail', { email: query })).user; }
      catch (error) {
        if (/users_not_found/.test((error as Error).message)) {
          const person = (await this.loadPeople()).find(p => p.email?.toLocaleLowerCase() === query.toLocaleLowerCase());
          return { matches: person ? [{ user: person.user, name: person.name, realName: person.realName, title: person.title,
            isBot: person.isBot, deleted: person.deleted, email: person.email }] : [], hasMore: false };
        }
        if (/missing_scope/.test((error as Error).message)) throw new Error('Add Slack scope users:read.email, then reconnect Slack');
        throw error;
      }
      if (!member || member.team_id !== identity.team && !member.teams?.includes(identity.team)) return { matches: [], hasMore: false };
      const person: Person = { user: String(member.id), name: String(member.profile?.display_name || member.real_name || member.name || member.id),
        realName: String(member.real_name || member.profile?.real_name || ''), title: String(member.profile?.title || ''),
        isBot: !!(member.is_bot || member.is_app_user), deleted: !!member.deleted, email: String(member.profile?.email || '') };
      if ((person.email || '').toLocaleLowerCase() !== query.toLocaleLowerCase()) return { matches: [], hasMore: false };
      return { matches: [person], hasMore: false };
    }
    const term = query.toLocaleLowerCase();
    const matches = (await this.loadPeople()).filter(person => [person.name, person.realName, person.handle || ''].some(value => value.toLocaleLowerCase().includes(term)));
    return { matches: matches.slice(0, 10).map(({ handle, email, ...person }) => person), hasMore: matches.length > 10 };
  }

  async resolveRecipient(raw: string) {
    const value = raw.trim();
    if (/^[UW][A-Z0-9]+$/.test(value)) {
      const member = await this.validateRecipient(value);
      return { user: value, name: String(member.profile?.display_name || member.real_name || member.name || value) };
    }
    const result = await this.searchPeople(value);
    if (result.matches.length !== 1 || result.hasMore) throw new RecipientMatchError(result.matches.length ? 'Several members match. Choose a Slack member ID.' : 'No members match.', result.matches, result.hasMore);
    const person = result.matches[0];
    if (person.isBot || person.deleted) throw new RecipientMatchError('Choose an active person in this workspace.', result.matches, false);
    await this.validateRecipient(person.user);
    return { user: person.user, name: person.name };
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
    if (Buffer.byteLength(encodeMessage(m, identity.name || identity.user)) > 39000 && !m.files?.some(f => f.longBody)) throw new Error('The encoded message is too large for Slack');
    const bytes = (m.files || []).map(verifyFile);
    await this.validateRecipient(m.to);
    const conversation = await this.slack.call('conversations.open', { users: m.to });
    const channel = conversation.channel?.id; if (!/^D[A-Z0-9]+$/.test(channel || '')) throw new Error('Slack did not return a direct conversation');
    if (this.slack.identity()?.user !== identity.user) throw new Error('Connection changed before sending');
    // the user can edit the draft while the checks above wait for Slack: post only the text that was approved
    this.store.update(id, x => {
      if (x.hash !== m.hash || x.approval?.hash !== m.hash) throw new Error('The message changed. Approve it again before sending.');
      if (x.sending || x.sentAt) throw new Error('Taskboard is already sending this message');
      x.sending = true; x.sendStartedAt = new Date().toISOString(); delete x.error;
    });
    try {
      for (const [index, f] of (m.files || []).entries()) {
        const slackId = await this.slack.upload(f.name, bytes[index], channel);
        this.store.update(id, x => { const file = x.files?.find(x => x.id === f.id); if (file) file.slackId = slackId; });
      }
      const sent = this.store.get(id);
      const task = sent.proposedBy?.task ? tasks.get(sent.proposedBy.task) : undefined;
      const proposer = sent.proposedBy?.actor === 'task'
        ? task ? `Task #${task.num} ${task.title}` : `Task ${sent.proposedBy.task || 'unknown'}`
        : sent.proposedBy?.actor === 'controller' ? 'Controller' : 'User';
      const blocks = buildMessageBlocks(sent, identity.name || identity.user, this.machineName(), proposer);
      const result = await this.slack.call('chat.postMessage', { channel, text: encodeMessage(sent, identity.name || identity.user), blocks: JSON.stringify(blocks), mrkdwn: 'false', unfurl_links: 'false', unfurl_media: 'false', parse: 'none', client_msg_id: m.id });
      if (!result.ts) throw new Error('Slack did not confirm delivery');
      return this.store.update(id, x => { x.sentAt = new Date().toISOString(); x.slackTs = result.ts; x.slackChannel = channel; x.sending = false; });
    } catch {
      this.store.update(id, x => { x.error = 'Slack did not confirm delivery. Check the conversation before retrying.'; });
      throw new Error('Delivery is uncertain. Check Slack before retrying.');
    }
  }
}
