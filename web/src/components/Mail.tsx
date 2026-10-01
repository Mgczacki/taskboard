// The Inbox page: messages with other people through A2A Notes (web/src/components/A2ANotes.tsx), notes from your
// tasks, and documents to review. Setup and Slack sign-in for messages are on the Settings page, under Integrations.
import { useEffect, useState } from 'react';
import type { Task } from '../api';
import { InboxPage as Documents } from './Review';
import { MessageList, TaskNotesList } from './A2ANotes';
import type { DocumentLink } from '../documentLinks';
import '../mail.css';

export function InboxPage(props: { tasks: Task[]; open: (id: string, tab?: 'terminal' | 'log' | 'docs') => void; documentLink?: DocumentLink | null }) {
  const [tab, setTab] = useState<'inbox' | 'sent' | 'documents'>(props.documentLink ? 'documents' : 'inbox');
  useEffect(() => { if (props.documentLink) setTab('documents'); }, [props.documentLink]);
  return <div className="account-mail">
    <nav className="mail-tabs" aria-label="Inbox sections">
      <button className="btn" onClick={() => setTab('inbox')} aria-pressed={tab === 'inbox'}>Messages</button>
      <button className="btn" onClick={() => setTab('documents')} aria-pressed={tab === 'documents'}>Documents to review</button>
      <button className="btn" onClick={() => setTab('sent')} aria-pressed={tab === 'sent'}>Sent</button>
    </nav>
    {tab === 'documents' ? <Documents {...props} />
      : tab === 'sent' ? <MessageList tasks={props.tasks} direction="outgoing" />
      : <><TaskNotesList tasks={props.tasks} /><MessageList tasks={props.tasks} direction="incoming" /></>}
  </div>;
}
