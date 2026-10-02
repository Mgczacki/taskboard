// Own the socket and its timers for one mounted terminal.
// After a close it connects again: first after 250 ms, then 500 ms, 1 s, 2 s and every 4 s (serverStatus.ts). A connection
// that lasted 5 s starts the waits again at 250 ms. Code 4001 (the tmux session is not running, server/pty.ts) waits
// 10 s, so a tab for an ended session does not start a tmux attach every second. Code 4004 (no such task) stops.
import { retryDelay } from './serverStatus';
export const MISSING_SESSION_RETRY_MS = 10000;
export function terminalSocket(url: () => string, handlers: {
  open: () => void;
  message: (event: MessageEvent) => void;
  close: (event: CloseEvent) => void;
}, create = (address: string) => new WebSocket(address)) {
  let socket: WebSocket | null = null;
  let disposed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0, openedAt = 0;
  const again = (ms = retryDelay(attempt++)) => { retry = setTimeout(connect, ms); };
  const connect = () => {
    if (disposed) return;
    const current = socket = create(url());
    deadline = setTimeout(() => {
      if (socket !== current || disposed) return;
      current.onclose = null;
      current.onopen = null;
      current.onmessage = null;
      current.close();
      handlers.close({ code: 1006, reason: 'connection timed out' } as CloseEvent);
      again();
    }, 10000);
    current.onopen = () => { clearTimeout(deadline); openedAt = Date.now(); if (!disposed) handlers.open(); };
    current.onmessage = event => { if (!disposed) handlers.message(event); };
    current.onclose = event => {
      clearTimeout(deadline);
      if (disposed) return;
      handlers.close(event);
      if (openedAt && Date.now() - openedAt >= 5000) attempt = 0;
      openedAt = 0;
      if (event.code === 4001) again(MISSING_SESSION_RETRY_MS);
      else if (event.code !== 4004) again();
    };
  };
  connect();
  return {
    get readyState() { return socket?.readyState; },
    send(data: string) { if (socket?.readyState === 1) socket.send(data); },
    dispose() {
      disposed = true;
      clearTimeout(retry);
      clearTimeout(deadline);
      if (socket) {
        socket.onopen = socket.onmessage = socket.onclose = null;
        socket.close();
      }
    },
  };
}
