// The browser view of a task on another machine (server/machines.ts). The dashboard opens /ws/browser on this server
// with the remote task id ("<machine>~<task id>"). index.ts opens /ws/browser on the other machine's server with that
// machine's token, and pipe() below copies the messages both ways:
// - from the view: text messages (input, size, 'hello', 'drawn' and the others of attachViewer). Messages that come
//   before the other server answers wait in a queue of at most QUEUE messages.
// - to the view: binary messages (one JPEG frame each) stay binary, text messages stay text.
// A slow view must not make this server keep many frames: while the view socket has more than BACKLOG bytes to send,
// a frame is dropped. The other server counts the frames that the view did not report yet (back pressure in
// attachViewer), so for each dropped frame this server reports 'drawn' itself, as the view does for a frame that it
// skips. Text messages are never dropped. Each side closes when the other side closes.
export const QUEUE = 256, BACKLOG = 2 * 1024 * 1024;

// The part of a WebSocket (the ws package) that pipe() uses, so a test can pass a fake socket.
export interface Sock {
  readyState: number;
  bufferedAmount: number;
  send(data: string | Buffer, opts?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
  on(ev: 'message', fn: (data: Buffer | string, binary: boolean) => void): void;
  on(ev: 'open' | 'close', fn: () => void): void;
  on(ev: 'error', fn: (e: Error) => void): void;
}
const OPEN = 1;

export function pipe(view: Sock, up: Sock) {
  const queue: string[] = [];
  let acks = false, closed = false;
  const end = (code?: number, reason?: string) => {
    if (closed) return;
    closed = true;
    try { view.close(code, reason); } catch { /* closed */ }
    try { up.close(); } catch { /* closed */ }
  };
  view.on('message', d => {
    const s = d.toString();
    if (!acks) { try { const m = JSON.parse(s); if (m?.type === 'hello' && m.acks) acks = true; } catch { /* not JSON */ } }
    if (up.readyState === OPEN) up.send(s);
    else if (queue.length < QUEUE) queue.push(s);
    else end(1009, 'browser queue full');
  });
  up.on('open', () => { for (const q of queue) up.send(q); queue.length = 0; });
  up.on('message', (d, binary) => {
    if (view.readyState !== OPEN) return;
    if (!binary) { view.send(d.toString()); return; }
    if (view.bufferedAmount > BACKLOG) { if (acks && up.readyState === OPEN) up.send(JSON.stringify({ type: 'drawn' })); return; }
    view.send(d as Buffer, { binary: true });
  });
  up.on('close', () => end());
  up.on('error', () => end(4502, 'machine unreachable'));
  view.on('close', () => end());
  view.on('error', () => end());
}
