// The Inbox page: messages with other people through A2A Notes (web/src/components/A2ANotes.tsx), notes from your
// tasks, and documents to review. Setup and Slack sign-in for messages are on the Settings page, under Integrations.
import { useEffect, useState } from 'react';
import type { Task } from '../api';
import { InboxPage as Documents } from './Review';
import { MessageList, TaskNotesList } from './A2ANotes';
import type { DocumentLink } from '../documentLinks';
import '../mail.css';

function focusFromHash(): { tab: 'inbox' | 'sent'; id: string } | undefined {
  const m = /^inbox:(messages|sent):(.+)$/.exec(decodeURIComponent(location.hash.slice(1)));
  return m ? { tab: m[1] === 'sent' ? 'sent' : 'inbox', id: m[2] } : undefined;
}

export function InboxPage(props: { tasks: Task[]; open: (id: string, tab?: 'terminal' | 'log' | 'docs') => void; documentLink?: DocumentLink | null }) {
  const [tab, setTab] = useState<'inbox' | 'sent' | 'documents'>(props.documentLink ? 'documents' : focusFromHash()?.tab || 'inbox');
  const [focus, setFocus] = useState(() => focusFromHash()?.id || '');
  useEffect(() => { if (props.documentLink) setTab('documents'); }, [props.documentLink]);
  // "Open in the Inbox" on a Message card sets #inbox:<messages|sent>:<message id>
  useEffect(() => { const on = () => { const f = focusFromHash(); if (f) { setTab(f.tab); setFocus(f.id); } }; addEventListener('hashchange', on); return () => removeEventListener('hashchange', on); }, []);
  return <div className="account-mail">
    <nav className="mail-tabs" aria-label="Inbox sections">
      <button className="btn" onClick={() => setTab('inbox')} aria-pressed={tab === 'inbox'}>Messages</button>
      <button className="btn" onClick={() => setTab('documents')} aria-pressed={tab === 'documents'}>Documents to review</button>
      <button className="btn" onClick={() => setTab('sent')} aria-pressed={tab === 'sent'}>Sent</button>
    </nav>
    {tab === 'documents' ? <Documents {...props} />
      : tab === 'sent' ? <MessageList tasks={props.tasks} direction="outgoing" focus={focus} />
      : <><TaskNotesList tasks={props.tasks} /><MessageList tasks={props.tasks} direction="incoming" focus={focus} /></>}
  </div>;
}
