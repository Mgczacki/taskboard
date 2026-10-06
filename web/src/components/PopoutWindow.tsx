import type { ReactNode } from 'react';

// The header is the drag area of a macOS window with a hidden native title bar.
// Keep interactive content below it so document links and text selection receive pointer events.
export function PopoutWindow({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return <div className="bw-window">
    <div className="bw-window-h"><b>{title}</b>{sub && <span className="sub">{sub}</span>}</div>
    {children}
  </div>;
}
