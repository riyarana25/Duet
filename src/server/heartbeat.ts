/**
 * Dead-connection detection: ping every socket on an interval; terminate any that didn't
 * pong since the last check. Generic WebSocketServer housekeeping — unrelated to anything
 * app-specific, split out so wsServer.ts only has to say "keep connections alive".
 */
import { WebSocket, WebSocketServer } from 'ws';

export interface LiveSocket extends WebSocket {
  isAlive?: boolean;
}

/** Marks a socket alive and refreshes that flag on every pong. Call once per new connection. */
export function trackLiveness(socket: LiveSocket): void {
  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });
}

/** Starts the ping sweep; returns a stop function (clears the interval). */
export function startHeartbeat(wss: WebSocketServer, intervalMs: number): () => void {
  const timer = setInterval(() => {
    for (const socket of wss.clients as Set<LiveSocket>) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
