/**
 * Fanout — cross-instance relay for ops/presence/chat over a MessageBus.
 *
 * A WebSocket is pinned to one process, so two users in the same room can end up on
 * different instances. This class is the only thing that knows about that: each instance
 * publishes its own local activity here and applies whatever its peers publish. Presence is
 * exchanged as full per-instance snapshots (not deltas); each instance shows the union of
 * its own + every remote instance's presence. Own echoes are dropped by instanceId. See
 * architecture.md for why a stateful WebSocket forces this design.
 *
 * When no bus is configured (single-instance mode), every publish/request method below is a
 * no-op — callers never need to branch on "are we scaled out?" themselves.
 */
import { randomUUID } from 'crypto';
import { Operation } from '../crdt/types';
import { ChatBroadcast, PresenceState } from '../net/protocol';
import { BusEnvelope, MessageBus } from './bus';
import { Room } from './room';

export class Fanout {
  readonly instanceId: string;
  private readonly subscribed = new Set<string>();
  /** docId -> (origin instanceId -> that instance's local presence). */
  private readonly remotePresence = new Map<string, Map<string, PresenceState[]>>();

  constructor(
    private readonly bus: MessageBus | undefined,
    /** Fetches (creating if needed) the Room a bus message applies to. */
    private readonly getRoom: (docId: string) => Promise<Room>,
  ) {
    this.instanceId = bus?.instanceId ?? randomUUID();
  }

  get active(): boolean {
    return this.bus !== undefined;
  }

  /** Subscribe to a doc's channel the first time this instance touches it. */
  async ensureSubscribed(docId: string): Promise<void> {
    if (!this.bus || this.subscribed.has(docId)) return;
    this.subscribed.add(docId);
    await this.bus.subscribe(docId, (env) => this.onBus(docId, env));
  }

  /** This instance's local presence merged with every remote instance's last-known presence. */
  presenceUnion(docId: string, room: Room): PresenceState[] {
    const out = [...room.presenceList()];
    const remotes = this.remotePresence.get(docId);
    if (remotes) for (const list of remotes.values()) out.push(...list);
    return out;
  }

  async broadcastPresence(docId: string): Promise<void> {
    const room = await this.getRoom(docId);
    room.broadcast({ t: 'presence', users: this.presenceUnion(docId, room) });
  }

  async publishLocalPresence(docId: string): Promise<void> {
    if (!this.bus) return;
    const room = await this.getRoom(docId);
    await this.bus.publish(docId, { kind: 'presence', origin: this.instanceId, users: room.presenceList() });
  }

  /** Ask peer instances to (re)publish their local presence — used when a client joins. */
  async requestPeerPresence(docId: string): Promise<void> {
    if (!this.bus) return;
    await this.bus.publish(docId, { kind: 'presence-request', origin: this.instanceId });
  }

  async publishOps(docId: string, ops: Operation[]): Promise<void> {
    if (!this.bus) return;
    await this.bus.publish(docId, { kind: 'ops', origin: this.instanceId, ops });
  }

  async publishChat(docId: string, msg: ChatBroadcast): Promise<void> {
    if (!this.bus) return;
    await this.bus.publish(docId, { kind: 'chat', origin: this.instanceId, msg });
  }

  private onBus(docId: string, env: BusEnvelope): void {
    if (env.origin === this.instanceId) return; // ignore our own echoes
    void this.handleBus(docId, env);
  }

  private async handleBus(docId: string, env: BusEnvelope): Promise<void> {
    const room = await this.getRoom(docId);
    switch (env.kind) {
      case 'ops': {
        const fresh = room.acceptRemote(env.ops);
        if (fresh.length > 0) room.broadcast({ t: 'ops', ops: fresh, from: env.origin });
        break;
      }
      case 'presence': {
        let m = this.remotePresence.get(docId);
        if (!m) {
          m = new Map();
          this.remotePresence.set(docId, m);
        }
        m.set(env.origin, env.users);
        room.broadcast({ t: 'presence', users: this.presenceUnion(docId, room) });
        break;
      }
      case 'presence-request': {
        await this.publishLocalPresence(docId);
        break;
      }
      case 'chat': {
        room.broadcast(env.msg);
        break;
      }
    }
  }
}
