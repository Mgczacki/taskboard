import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Approver } from './policy.ts';

export type Verdict = 'communication' | 'uncertain' | 'action-request' | 'quarantine';
export interface MailFile { id: string; name: string; size: number; hash: string; path: string; slackId?: string; longBody?: boolean; review?: { verdict: Verdict; reason: string; at: string }; routed?: { task: string; path: string; at: string } }
export interface Message {
  id: string; direction: 'inbox' | 'outbox'; source: 'agent' | 'slack' | 'user';
  from: string; to: string; subject: string; body: string; hash: string;
  proposedBy?: { actor: 'user' | 'controller' | 'task'; task?: string; agent?: string };
  created: string; updated: string; dismissedAt?: string;
  review?: { verdict: Verdict; reason: string; at: string };
  approval?: { by: 'user' | 'controller'; at: string; hash: string };
  rejectedAt?: string; sendStartedAt?: string; sentAt?: string; slackTs?: string; slackChannel?: string;
  sending?: boolean; error?: string;
  routes: { task: string; path: string; at: string; by?: 'user' | 'controller' }[];
  files?: MailFile[];
  // incoming: the task the controller proposes (null: no task needs it); the user approves it on the approval card
  proposedRoute?: { task: string | null; at: string };
  // comments from the user when they sent the approval card back
  returns?: { comment: string; at: string }[];
  // routed by the controller without the user's approval, and the user has not opened it yet
  unseen?: boolean;
}
export interface TrustedSender { user: string; name: string; at: string }
export interface Contact { user: string; name: string; channel: string; oldest: string; status?: 'requested' | 'active' | 'needs-request'; requestId?: string }
export interface ContactRequest { user: string; name: string; channel: string; requestId: string; at: string }
export interface MailScan { oldest: string; latest: string; cursor: string; lastPageAt: number }
export interface MailData {
  version: 1; messages: Message[]; contacts: Contact[];
  requests?: ContactRequest[]; requestCursors?: Record<string, string>;
  messageCursors?: Record<string, string>; messageScans?: Record<string, MailScan>; recentScans?: Record<string, MailScan>;
  staged?: MailFile[]; owner?: string; trustedSenders?: TrustedSender[];
  // replaced by the outgoing level in machine.json; read once to migrate the Inbox checkbox
  controllerApproval?: boolean;
}
export function hashMessage(subject: string, body: string, to: string, files: MailFile[] = []) {
  return createHash('sha256').update(JSON.stringify([subject, body, to, files.map(f => [f.name, f.size, f.hash])])).digest('hex');
}
export function validText(value: unknown, limit: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}
export function savePrivate(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(data, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
}
export class MailStore {
  constructor(readonly file: string) {}
  read(): MailData {
    if (!existsSync(this.file)) return { version: 1, messages: [], contacts: [] };
    const data = JSON.parse(readFileSync(this.file, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.messages) || !Array.isArray(data.contacts)) throw new Error('Mailbox storage needs repair');
    return data;
  }
  change<T>(fn: (data: MailData) => T): T {
    const data = this.read(); const result = fn(data); savePrivate(this.file, data); return result;
  }
  get(id: string) { const m = this.read().messages.find(x => x.id === id); if (!m) throw new Error('No such message'); return m; }
  update(id: string, fn: (m: Message) => void) {
    return this.change(data => { const m = data.messages.find(x => x.id === id); if (!m) throw new Error('No such message'); fn(m); m.updated = new Date().toISOString(); return m; });
  }
  add(input: Pick<Message, 'direction' | 'source' | 'from' | 'to' | 'subject' | 'body'> & Partial<Pick<Message, 'id' | 'slackTs' | 'slackChannel' | 'files' | 'proposedBy'>>) {
    validText(input.subject, 200, 'subject'); validText(input.body, 262144, 'message body');
    validText(input.from, 200, 'sender'); validText(input.to, 200, 'recipient');
    return this.change(data => {
      const duplicate = input.id && data.messages.find(m => m.id === input.id);
      if (duplicate) return duplicate;
      if (data.messages.length >= 10000) throw new Error('Mailbox is full');
      const now = new Date().toISOString();
      const m: Message = { ...input, id: input.id || randomUUID(), hash: hashMessage(input.subject, input.body, input.to, input.files), created: now, updated: now, routes: [] };
      data.messages.push(m); return m;
    });
  }
  // approver: who the permission levels allow to approve this message now (server/mail/policy.ts)
  approve(id: string, by: 'user' | 'controller', expectedHash: string, approver: Approver) {
    return this.update(id, m => {
      if (expectedHash !== m.hash) throw new Error('The message changed. Read it again before approving.');
      if (m.dismissedAt || m.rejectedAt) throw new Error('Restore the message before approval');
      if (!m.review) throw new Error('Controller review must finish first');
      if (m.review?.verdict === 'quarantine') throw new Error('Quarantined messages cannot be approved');
      if (by === 'controller' && approver !== 'controller') throw new Error('This message needs human approval');
      if (by === 'user' && approver === 'nobody') throw new Error('This message failed the safety check and cannot be approved');
      m.approval = { by, at: new Date().toISOString(), hash: m.hash };
    });
  }
}
