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
