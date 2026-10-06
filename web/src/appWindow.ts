// Inside the Mac app (desktop/preload.cjs sets window.taskboardApp): mark the page with body.in-app, so app.css adds the
// window drag areas and leaves room for the window buttons. The class app-buttons follows the window buttons, which
// the app shows while the pointer is near the top edge ('taskboard:chrome'). App.tsx, BrowserWindowPage and
// DocumentWindowPage call it: each is the whole page of its window.
import { useEffect } from 'react';

export const isApp = () => !!(window as unknown as { taskboardApp?: { isApp: boolean } }).taskboardApp?.isApp;

export function useAppWindow() {
  useEffect(() => {
    if (!isApp()) return;
    document.body.classList.add('in-app');
    const on = (e: Event) => document.body.classList.toggle('app-buttons', !!(e as CustomEvent<{ buttons: boolean }>).detail?.buttons);
    addEventListener('taskboard:chrome', on); return () => removeEventListener('taskboard:chrome', on);
  }, []);
}
