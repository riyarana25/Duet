/**
 * Room — server-side state for ONE document (one room per docId).
 *
 * Phase 2 role (relay + presence) PLUS Phase 3 persistence:
 *  - Maintains a server-side RGADocument replica by applying every accepted op. Applying
 *    convergent CRDT ops is not last-write-wins; it just materializes the same state every
 *    replica would compute. The room still relays ops verbatim (no merge, no reorder).
 *  - Keeps `recentOps` = ops accepted since the last snapshot, and a `persistedSnapshot`.
 *    A (re)joining client gets `snapshot + recentOps` and replays to converge (logic.md §7).
 *  - Snapshots every `snapshotEveryOps` accepted ops. Durable writes go through a per-room
 *    serialized queue so they can't interleave/race (see store.ts for the interval tradeoff).
 */
import { DocSnapshot, Operation } from '../crdt/types';
import { RGADocument } from '../crdt/document';
import { CursorPos, PresenceState, PresenceUser, ServerMessage, opSignature } from '../net/protocol';
import { DocStore } from './store';

/** A connected socket, abstracted so Room doesn't depend on `ws` directly (testable). */
export interface RoomSocket {
  send(data: string): void;
}

interface RoomClient {
  readonly clientId: string;
  readonly socket: RoomSocket;
  readonly user: PresenceUser;
  cursor: CursorPos | null;
}

/** The server replica never authors ops, so its site id is only a placeholder. */
const SERVER_SITE = 'server';

export class Room {
  private readonly clients = new Map<string, RoomClient>();
  private readonly seen = new Set<string>();

  private replica: RGADocument;
  private persistedSnapshot: DocSnapshot | null = null;
  private recentOps: Operation[] = [];
  private opsSinceSnapshot = 0;

  /** Serializes all durable writes for this doc so they never interleave. */
  private persistTail: Promise<void> = Promise.resolve();

  private constructor(
    public readonly docId: string,
    private readonly store: DocStore,
    private readonly snapshotEveryOps: number,
  ) {
    this.replica = new RGADocument(SERVER_SITE);
  }

  /** Construct a Room, hydrating its state from the store (snapshot + ops-since). */
  static async create(docId: string, store: DocStore, snapshotEveryOps: number): Promise<Room> {
    const room = new Room(docId, store, snapshotEveryOps);
    const loaded = await store.loadDocument(docId);
    room.persistedSnapshot = loaded.snapshot;
    room.recentOps = [...loaded.ops];
    room.replica = loaded.snapshot
      ? RGADocument.fromSnapshot(SERVER_SITE, loaded.snapshot)
      : new RGADocument(SERVER_SITE);
    for (const op of loaded.ops) {
      room.replica.apply(op);
      room.seen.add(opSignature(op));
    }
    if (loaded.snapshot) {
      for (const el of loaded.snapshot.elements) {
        room.seen.add(opSignature({ type: 'insert', ...el }));
      }
      for (const key of loaded.snapshot.deleted) room.seen.add(`d:${key}`);
    }
    return room;
  }

  get size(): number {
    return this.clients.size;
  }
  isEmpty(): boolean {
    return this.clients.size === 0;
  }

  // ---- membership / presence (Phase 2) ----

  join(clientId: string, socket: RoomSocket, user: PresenceUser): void {
    this.clients.set(clientId, { clientId, socket, user, cursor: null });
  }
  remove(clientId: string): void {
    this.clients.delete(clientId);
  }
  setCursor(clientId: string, cursor: CursorPos | null): void {
    const c = this.clients.get(clientId);
    if (c) c.cursor = cursor;
  }
  presenceList(): PresenceState[] {
    return [...this.clients.values()].map((c) => ({
      clientId: c.clientId,
      user: c.user,
      cursor: c.cursor,
    }));
  }

  // ---- ops / persistence (Phase 3) ----

  /** State a newcomer needs to catch up: last snapshot + ops since it. */
  welcomeState(): { snapshot: DocSnapshot | null; ops: Operation[] } {
    return { snapshot: this.persistedSnapshot, ops: this.recentOps };
  }

  /**
   * Ops from a local client: dedup + apply + buffer + durably persist (and snapshot on
   * interval). Returns the newly-accepted ops to relay. In-memory state updates
   * synchronously (hot path); durable writes are queued async.
   */
  acceptLocal(ops: Operation[]): Operation[] {
    const fresh = this.ingest(ops);
    if (fresh.length > 0) {
      this.enqueue(() => this.store.appendOps(this.docId, fresh));
      if (this.opsSinceSnapshot >= this.snapshotEveryOps) this.takeSnapshot();
    }
    return fresh;
  }

  /**
   * Ops arriving from another instance via the bus: dedup + apply + buffer so this
   * instance can serve/catch-up its own clients — but do not persist. With a shared store
   * each op is written exactly once, by its originating instance (no double-write/race).
   */
  acceptRemote(ops: Operation[]): Operation[] {
    return this.ingest(ops);
  }

  /** Dedup, apply to the replica, buffer as recent. Returns newly-accepted ops. */
  private ingest(ops: Operation[]): Operation[] {
    const fresh: Operation[] = [];
    for (const op of ops) {
      const sig = opSignature(op);
      if (this.seen.has(sig)) continue;
      this.seen.add(sig);
      this.replica.apply(op);
      this.recentOps.push(op);
      this.opsSinceSnapshot += 1;
      fresh.push(op);
    }
    return fresh;
  }

  /** Snapshot current replica state; clears the recent-op buffer. */
  private takeSnapshot(): void {
    const snapshot = this.replica.snapshot();
    this.persistedSnapshot = snapshot;
    this.recentOps = [];
    this.opsSinceSnapshot = 0;
    this.enqueue(() => this.store.saveSnapshot(this.docId, snapshot));
  }

  private enqueue(task: () => Promise<void>): void {
    this.persistTail = this.persistTail.then(task).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[room ${this.docId}] persistence error:`, err);
    });
  }

  /** Resolves when all queued durable writes have completed (used by tests / shutdown). */
  whenPersisted(): Promise<void> {
    return this.persistTail;
  }

  // ---- broadcast ----

  broadcast(msg: ServerMessage, exceptClientId?: string): void {
    const data = JSON.stringify(msg);
    for (const c of this.clients.values()) {
      if (c.clientId === exceptClientId) continue;
      c.socket.send(data);
    }
  }
  sendTo(clientId: string, msg: ServerMessage): void {
    this.clients.get(clientId)?.socket.send(JSON.stringify(msg));
  }
}
