/**
 * MessageBus — the cross-instance fan-out layer (Phase 4).
 *
 * A single WebSocket is pinned to one server process, so two users in the same room may be
 * connected to different instances. The bus carries ops and presence between instances so
 * those users still converge. Each instance tags messages with its `instanceId` and ignores
 * its own echoes (the bus delivers a publish back to the publisher too). See architecture.md
 * for the stateful-WebSocket scaling reasoning.
 *
 * One channel per docId: an instance only subscribes to docs it actually hosts.
 */
import { randomUUID } from 'crypto';
import { Operation } from '../crdt/types';
import { PresenceState } from '../net/protocol';

export type BusEnvelope =
  | { kind: 'ops'; origin: string; ops: Operation[] }
  /** The origin instance's local presence snapshot (full, not a delta). */
  | { kind: 'presence'; origin: string; users: PresenceState[] }
  /** Ask peers to (re)publish their local presence — sent when a client joins. */
  | { kind: 'presence-request'; origin: string };

export type BusHandler = (env: BusEnvelope) => void;

export interface MessageBus {
  readonly instanceId: string;
  publish(docId: string, env: BusEnvelope): Promise<void>;
  subscribe(docId: string, handler: BusHandler): Promise<void>;
  unsubscribe(docId: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Shared in-process broker so multiple InMemoryBus "instances" (simulated servers in a
 * test, or threads in one process) can talk. Delivery is async (microtask) to mimic a
 * real network hop and exercise out-of-order handling.
 */
export class InMemoryBroker {
  private readonly subs = new Map<string, Set<BusHandler>>();

  add(docId: string, handler: BusHandler): void {
    let set = this.subs.get(docId);
    if (!set) {
      set = new Set();
      this.subs.set(docId, set);
    }
    set.add(handler);
  }
  remove(docId: string, handler: BusHandler): void {
    this.subs.get(docId)?.delete(handler);
  }
  publish(docId: string, env: BusEnvelope): void {
    const set = this.subs.get(docId);
    if (!set) return;
    for (const handler of [...set]) queueMicrotask(() => handler(env));
  }
}

/** In-memory MessageBus over a shared broker. Default for tests (no external dependency). */
export class InMemoryBus implements MessageBus {
  readonly instanceId = randomUUID();
  private readonly handlers = new Map<string, BusHandler>();

  constructor(private readonly broker: InMemoryBroker) {}

  async publish(docId: string, env: BusEnvelope): Promise<void> {
    this.broker.publish(docId, env);
  }
  async subscribe(docId: string, handler: BusHandler): Promise<void> {
    this.handlers.set(docId, handler);
    this.broker.add(docId, handler);
  }
  async unsubscribe(docId: string): Promise<void> {
    const handler = this.handlers.get(docId);
    if (handler) this.broker.remove(docId, handler);
    this.handlers.delete(docId);
  }
  async close(): Promise<void> {
    for (const [docId, handler] of this.handlers) this.broker.remove(docId, handler);
    this.handlers.clear();
  }
}
