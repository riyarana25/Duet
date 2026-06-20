/** Browser transport backed by the global WebSocket. Mirrors transport.node.ts. */
import { Transport } from './transport';

export function browserWsTransport(url: string): Transport {
  const ws = new WebSocket(url);
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    isOpen: () => ws.readyState === WebSocket.OPEN,
    onOpen: (cb) => ws.addEventListener('open', () => cb()),
    onMessage: (cb) =>
      ws.addEventListener('message', (e: MessageEvent) => {
        if (typeof e.data === 'string') cb(e.data);
      }),
    onClose: (cb) => ws.addEventListener('close', () => cb()),
  };
}
