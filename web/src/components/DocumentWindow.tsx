import { useEffect, useRef } from 'react';
import { useAppWindow } from '../appWindow';
import { pathOfFileUrl, type DocumentLink } from '../documentLinks';
import { documentWindowUrl, renderMarkdown } from './Docs';
import { DocumentTools } from './DocumentTools';
import { PopoutWindow } from './PopoutWindow';

// The full-size window of one HTML or Markdown document (/?document=<file address>&title=<name>).
// The comment and BTW controls (DocumentTools.tsx) are part of this page. An HTML document runs in the sandboxed
// iframe below them, and Markdown is drawn sanitized.
export function DocumentWindowPage() {
  const q = new URLSearchParams(location.search);
  const src = q.get('document') || '';
  const title = q.get('title') || 'HTML document';
  const valid = src.startsWith('/api/files/') || src.startsWith('/api/file?');
  const path = valid ? pathOfFileUrl(src) : '';
  const markdown = /\.(md|markdown)$/i.test(src.split(/[?#]/)[0]) || /\.(md|markdown)$/i.test(path);
  useAppWindow();
  useEffect(() => { document.title = title; }, [title]);
  return <PopoutWindow title={title}>
    {!valid ? <div className="document-window-error">The document address is invalid.</div>
      : <DocumentTools path={path}>
        {markdown ? <MarkdownDocument src={src} path={path} /> : <iframe className="document-window-frame" src={src} title={title} sandbox="allow-scripts allow-popups" />}
      </DocumentTools>}
  </PopoutWindow>;
}

// This window has no task panels. A link to another document opens that document in its own window.
function MarkdownDocument({ src, path }: { src: string; path: string }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current || !path) return;
    el.current.textContent = '';
    void renderMarkdown(el.current, path, { heading: decodeURIComponent(location.hash.slice(1)) || undefined });
    const open = (e: Event) => { const d = (e as CustomEvent<DocumentLink | { path: string }>).detail; window.open(documentWindowUrl(d.path), '_blank'); };
    addEventListener('taskboard:document-link', open); addEventListener('taskboard:vault-document', open);
    return () => { removeEventListener('taskboard:document-link', open); removeEventListener('taskboard:vault-document', open); };
  }, [path]);
  if (!path) return <iframe className="document-window-frame" src={src} title="Document" sandbox="allow-scripts allow-popups" />;
  return <div className="document-window-md" ref={el} />;
}
