export interface DocumentLink {
  task: string;
  box: 'inbox' | 'outbox';
  path: string;
  name: string;
  kind: 'md' | 'html' | 'other';
  reviewId?: string;
  line?: number;
  heading?: string;
}

export function openDocumentLink(link: DocumentLink) {
  dispatchEvent(new CustomEvent<DocumentLink>('taskboard:document-link', { detail: link }));
}

// The path of a local file from its Taskboard file address (Docs.tsx fileUrl), or '' for another address.
export function pathOfFileUrl(src: string): string {
  try {
    if (src.startsWith('/api/files/')) return '/' + src.slice('/api/files/'.length).split(/[?#]/)[0].split('/').map(decodeURIComponent).join('/');
    if (src.startsWith('/api/file?')) { const q = new URLSearchParams(src.slice('/api/file?'.length).split('#')[0]); return q.get('machine') ? '' : q.get('path') || ''; }
  } catch { /* not a valid address */ }
  return '';
}
