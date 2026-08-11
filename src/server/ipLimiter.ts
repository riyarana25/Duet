/**
 * Per-IP concurrent-connection cap: keeps one client from opening unbounded sockets and
 * starving the connection budget for everyone else. Split out of wsServer.ts so the
 * connection-handling code doesn't have to interleave counting logic with message logic.
 */
import { IncomingMessage } from 'http';

export class IpConnLimiter {
  private readonly counts = new Map<string, number>();

  constructor(private readonly maxPerIp: number) {}

  /** Returns the request's client IP if it's under the cap (and reserves a slot), else null. */
  acquire(req: IncomingMessage): string | null {
    const ip = clientIp(req);
    const count = this.counts.get(ip) ?? 0;
    if (count >= this.maxPerIp) return null;
    this.counts.set(ip, count + 1);
    return ip;
  }

  release(ip: string): void {
    const n = (this.counts.get(ip) ?? 1) - 1;
    if (n <= 0) this.counts.delete(ip);
    else this.counts.set(ip, n);
  }
}

/** Behind a proxy/load balancer the client IP arrives in x-forwarded-for (first hop). */
function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  return (
    (typeof fwd === 'string' ? fwd.split(',')[0]?.trim() : undefined) ||
    req.socket.remoteAddress ||
    'unknown'
  );
}
