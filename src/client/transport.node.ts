/** Node transport backed by the `ws` library (used by tests and any server-side client). */
import { WebSocket } from 'ws';
import { Transport } from './transport';

export function nodeWsTransport(url: string): Transport {
  const ws = new WebSocket(url);
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    isOpen: () => ws.readyState === WebSocket.OPEN,
    onOpen: (cb) => ws.on('open', cb),
    onMessage: (cb) => ws.on('message', (data) => cb(data.toString())),
    onClose: (cb) => ws.on('close', () => cb()),
  };
}
