/**
 * Abuse guards for the public-facing server: rate limits, size caps, and strict frame
 * validation. These are the APP-level protections — per-connection and per-IP budgets
 * that keep one misbehaving client from starving a room, filling the store, or running
 * up the AI bill. Volumetric DDoS (raw packet/connection floods) is NOT solvable in
 * application code; that layer belongs to the platform/CDN in front (see README).
 *
 * Limits are deliberately generous for humans and tight for scripts: real typing is
 * ~10 ops/s, a big paste is a burst of a few thousand — both fit comfortably.
 */
import { Operation } from '../crdt/types';
import { ClientMessage, PresenceUser } from '../net/protocol';

export const LIMITS = {
  /** Concurrent sockets allowed per client IP. */
  maxConnsPerIp: 16,
  /** Participants per room. */
  maxClientsPerRoom: 32,
  /** Distinct rooms one instance will materialize. */
  maxRooms: 500,
  /** CRDT ops accepted per connection per 10s window (typing ≈ 10/s; pastes burst). */
  maxOpsPer10s: 20_000,
  /** Total elements (incl. tombstones) a document may hold before ops are refused. */
  maxDocElements: 400_000,
  /** Ops allowed in a single frame. */
  maxOpsPerFrame: 10_000,
  /** AI requests per connection per minute (each one costs real money). */
  maxAiPerMinute: 6,
  /** Longest selection an AI request may carry. */
  maxAiTextLen: 8_000,
  /** WebSocket frame size cap (ws `maxPayload`). */
  maxPayloadBytes: 2 * 1024 * 1024,
  maxNameLen: 40,
  maxUserIdLen: 64,
  maxDocIdLen: 64,
  /** Chat: message length and messages per 10s window. */
  maxChatLen: 500,
  maxChatPer10s: 15,
} as const;

/** Sliding-window rate limiter: `allow(n)` consumes n units if the window has room. */
export class SlidingWindow {
  private readonly entries: Array<[number, number]> = []; // [timestamp, units]
  private total = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(n = 1): boolean {
    const now = Date.now();
    while (this.entries.length > 0 && now - this.entries[0]![0] > this.windowMs) {
      this.total -= this.entries.shift()![1];
    }
    if (this.total + n > this.limit) return false;
    this.entries.push([now, n]);
    this.total += n;
    return true;
  }
}

/** Presence identity from the wire: clamp lengths, strip control chars, verify colour. */
export function sanitizeUser(u: unknown): PresenceUser | null {
  if (typeof u !== 'object' || u === null) return null;
  const o = u as Record<string, unknown>;
  if (typeof o.name !== 'string' || typeof o.userId !== 'string' || typeof o.color !== 'string') {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  const name = o.name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, LIMITS.maxNameLen) || 'anonymous';
  const userId = o.userId.slice(0, LIMITS.maxUserIdLen);
  const color = /^#[0-9a-fA-F]{6}$/.test(o.color) ? o.color : '#d97706';
  return { name, userId, color };
}

function isElementId(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const id = v as Record<string, unknown>;
  return typeof id.site === 'string' && id.site.length <= 128 && typeof id.counter === 'number';
}

/**
 * Strict op validation. The critical rule: an insert carries EXACTLY ONE character.
 * Without it a client could smuggle megabyte "characters" past the op rate limit.
 */
export function isValidOp(v: unknown): v is Operation {
  if (typeof v !== 'object' || v === null) return false;
  const op = v as Record<string, unknown>;
  if (!isElementId(op.id) || typeof op.lamport !== 'number') return false;
  if (op.type === 'delete') return true;
  if (op.type !== 'insert') return false;
  if (typeof op.value !== 'string' || op.value.length !== 1) return false;
  return op.originId === null || isElementId(op.originId);
}

/** Shape-check an inbound frame before it reaches any handler. */
export function isValidClientMessage(m: unknown): m is ClientMessage {
  if (typeof m !== 'object' || m === null) return false;
  const msg = m as Record<string, unknown>;
  switch (msg.t) {
    case 'join':
      return typeof msg.docId === 'string' && msg.docId.length <= LIMITS.maxDocIdLen;
    case 'ops':
      return (
        Array.isArray(msg.ops) &&
        msg.ops.length > 0 &&
        msg.ops.length <= LIMITS.maxOpsPerFrame &&
        msg.ops.every(isValidOp)
      );
    case 'cursor': {
      if (msg.cursor === null) return true;
      if (typeof msg.cursor !== 'object' || msg.cursor === null) return false;
      const c = msg.cursor as Record<string, unknown>;
      return (
        (c.anchor === null || isElementId(c.anchor)) && (c.focus === null || isElementId(c.focus))
      );
    }
    case 'ai':
      return (
        typeof msg.requestId === 'string' &&
        msg.requestId.length <= 64 &&
        (msg.action === 'summarize' || msg.action === 'improve') &&
        typeof msg.text === 'string' &&
        msg.text.length <= LIMITS.maxAiTextLen
      );
    case 'chat':
      return (
        typeof msg.text === 'string' &&
        msg.text.trim().length > 0 &&
        msg.text.length <= LIMITS.maxChatLen
      );
    default:
      return false;
  }
}
