import { useEffect } from 'react';
import { useAppWindow } from '../appWindow';
import { PopoutWindow } from './PopoutWindow';

export function DocumentWindowPage() {
  const q = new URLSearchParams(location.search);
  const src = q.get('document') || '';
  const title = q.get('title') || 'HTML document';
  const valid = src.startsWith('/api/files/') || src.startsWith('/api/file?');
  useAppWindow();
  useEffect(() => { document.title = title; }, [title]);
  return <PopoutWindow title={title}>
    {valid ? <iframe className="document-window-frame" src={src} title={title} sandbox="allow-scripts allow-popups" />
      : <div className="document-window-error">The document address is invalid.</div>}
  </PopoutWindow>;
}
