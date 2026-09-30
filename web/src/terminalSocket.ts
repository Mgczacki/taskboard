// Own the socket and its timers for one mounted terminal.
export function terminalSocket(url: () => string, handlers: {
  open: () => void;
  message: (event: MessageEvent) => void;
  close: (event: CloseEvent) => void;
}, create = (address: string) => new WebSocket(address)) {
  let socket: WebSocket | null = null;
  let disposed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
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
      retry = setTimeout(connect, 1500);
    }, 10000);
    current.onopen = () => { clearTimeout(deadline); if (!disposed) handlers.open(); };
    current.onmessage = event => { if (!disposed) handlers.message(event); };
    current.onclose = event => {
      clearTimeout(deadline);
      if (disposed) return;
      handlers.close(event);
      if (event.code !== 4004) retry = setTimeout(connect, 1500);
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
