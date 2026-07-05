/**
 * WebSocket server: routes connections to per-doc Rooms, drives the connection lifecycle,
 * and (Phase 4) fans out ops/presence across server instances via a MessageBus.
 *
 * Local delivery: ops from a client are relayed to that instance's other local sockets.
 * Cross-instance: ops are also published to the bus; ops arriving from the bus are applied
 * to the local room and relayed to local sockets (never re-published — own echoes are
 * dropped by instanceId). Presence is exchanged as per-instance snapshots; each instance
 * shows the union of local + remote presence. Why WebSockets force this design: architecture.md.
 */
import { randomUUID } from 'crypto';
import { IncomingMessage, Server as HttpServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { ClientMessage, PresenceState, ServerMessage } from '../net/protocol';
import { Room } from './room';
import { DocStore, InMemoryStore } from './store';
import { BusEnvelope, MessageBus } from './bus';
import { AIAction, AIService } from '../ai/aiService';
import { LIMITS, SlidingWindow, isValidClientMessage, sanitizeUser } from './guard';

export interface ServerOptions {
  store?: DocStore;
  /** Snapshot after this many accepted ops (single-instance only; see store.ts). */
  snapshotEveryOps?: number;
  /** Cross-instance fan-out bus. Omit for a standalone single-instance server. */
  bus?: MessageBus;
  /** AI assist backend (Phase 5). Omit to disable; requests then get an error result. */
  ai?: AIService;
  /** Attach the WS layer to an existing HTTP server (shares a port with static files). */
  server?: HttpServer;
}

export interface ServerHandle {
  readonly port: number;
  readonly roomCount: () => number;
  whenPersisted: () => Promise<void>;
  close: () => Promise<void>;
}

interface LiveSocket extends WebSocket {
  isAlive?: boolean;
}

const HEARTBEAT_MS = 30_000;

class EditorServer {
  private readonly rooms = new Map<string, Promise<Room>>();
  private readonly subscribed = new Set<string>();
  /** docId -> (origin instanceId -> that instance's local presence). */
  private readonly remotePresence = new Map<string, Map<string, PresenceState[]>>();
  /** Live socket count per client IP (per-IP connection cap). */
  private readonly ipConns = new Map<string, number>();
  private readonly instanceId: string;

  constructor(
    private readonly store: DocStore,
    private readonly snapshotEveryOps: number,
    private readonly bus: MessageBus | undefined,
    private readonly ai: AIService | undefined,
  ) {
    this.instanceId = bus?.instanceId ?? randomUUID();
  }

  // ---- rooms ----

  async getRoom(docId: string): Promise<Room> {
    let p = this.rooms.get(docId);
    if (!p) {
      if (this.bus && !this.subscribed.has(docId)) {
        this.subscribed.add(docId);
        await this.bus.subscribe(docId, (env) => this.onBus(docId, env));
      }
      // Multi-instance: disable auto-snapshot (a shared op log truncation would race across
      // instances). The append-only op log stays safe because each op is persisted once by
      // its origin; distributed snapshotting needs per-doc ownership — out of scope here.
      const everyOps = this.bus ? Number.POSITIVE_INFINITY : this.snapshotEveryOps;
      p = Room.create(docId, this.store, everyOps);
      this.rooms.set(docId, p);
    }
    return p;
  }

  roomCount(): number {
    return this.rooms.size;
  }

  // ---- presence (union of local + remote) ----

  private presenceUnion(docId: string, room: Room): PresenceState[] {
    const out = [...room.presenceList()];
    const remotes = this.remotePresence.get(docId);
    if (remotes) for (const list of remotes.values()) out.push(...list);
    return out;
  }

  private async broadcastPresence(docId: string): Promise<void> {
    const room = await this.getRoom(docId);
    room.broadcast({ t: 'presence', users: this.presenceUnion(docId, room) });
  }

  private async publishLocalPresence(docId: string): Promise<void> {
    if (!this.bus) return;
    const room = await this.getRoom(docId);
    await this.bus.publish(docId, {
      kind: 'presence',
      origin: this.instanceId,
      users: room.presenceList(),
    });
  }

  // ---- bus inbound ----

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

  // ---- connection ----

  attach(socket: LiveSocket, req: IncomingMessage): void {
    const docId = (
      new URL(req.url ?? '/', 'http://localhost').searchParams.get('doc') ?? 'default'
    ).slice(0, LIMITS.maxDocIdLen);
    const clientId = randomUUID();
    let roomPromise: Promise<Room> | null = null;

    // Per-IP connection cap. Behind a proxy/load balancer the client IP arrives in
    // x-forwarded-for (first hop); direct connections use the socket address.
    const fwd = req.headers['x-forwarded-for'];
    const ip =
      (typeof fwd === 'string' ? fwd.split(',')[0]?.trim() : undefined) ||
      req.socket.remoteAddress ||
      'unknown';
    const ipCount = this.ipConns.get(ip) ?? 0;
    if (ipCount >= LIMITS.maxConnsPerIp) {
      socket.close(4001, 'too many connections');
      return;
    }
    this.ipConns.set(ip, ipCount + 1);

    // Per-connection budgets (see guard.ts for the reasoning behind the numbers).
    const opWindow = new SlidingWindow(LIMITS.maxOpsPer10s, 10_000);
    const aiWindow = new SlidingWindow(LIMITS.maxAiPerMinute, 60_000);
    const chatWindow = new SlidingWindow(LIMITS.maxChatPer10s, 10_000);

    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });

    // Strict per-connection ordering; each step may await async room loading.
    let chain: Promise<void> = Promise.resolve();

    const handle = async (msg: ClientMessage): Promise<void> => {
      switch (msg.t) {
        case 'join': {
          const user = sanitizeUser(msg.user);
          if (!user) {
            socket.close(4003, 'invalid identity');
            return;
          }
          // Room caps: don't let one instance materialize unbounded rooms, or one room
          // hold unbounded sockets.
          if (!this.rooms.has(docId) && this.rooms.size >= LIMITS.maxRooms) {
            socket.close(4005, 'server full');
            return;
          }
          roomPromise = this.getRoom(docId);
          const room = await roomPromise;
          if (room.size >= LIMITS.maxClientsPerRoom) {
            roomPromise = null;
            socket.close(4004, 'room full');
            return;
          }
          room.join(clientId, socket, user);
          const state = room.welcomeState();
          room.sendTo(clientId, {
            t: 'welcome',
            selfId: clientId,
            snapshot: state.snapshot,
            ops: state.ops,
            presence: this.presenceUnion(docId, room),
          });
          await this.broadcastPresence(docId); // local sockets see the new participant
          if (this.bus) {
            await this.publishLocalPresence(docId); // tell peers about us
            await this.bus.publish(docId, { kind: 'presence-request', origin: this.instanceId });
          }
          break;
        }
        case 'ops': {
          if (!roomPromise) return;
          if (!opWindow.allow(msg.ops.length)) {
            socket.close(4008, 'rate limit exceeded');
            return;
          }
          const room = await roomPromise;
          // Document size cap: past it, ops are dropped (the doc is full; a client that
          // legitimately hits this has pasted a small book).
          if (room.elementCount() + msg.ops.length > LIMITS.maxDocElements) return;
          const fresh = room.acceptLocal(msg.ops);
          if (fresh.length > 0) {
            room.broadcast({ t: 'ops', ops: fresh, from: clientId }, clientId);
            if (this.bus) await this.bus.publish(docId, { kind: 'ops', origin: this.instanceId, ops: fresh });
          }
          break;
        }
        case 'cursor': {
          if (!roomPromise) return;
          const room = await roomPromise;
          room.setCursor(clientId, msg.cursor);
          await this.broadcastPresence(docId);
          await this.publishLocalPresence(docId);
          break;
        }
        case 'chat': {
          if (!roomPromise) return;
          if (!chatWindow.allow()) return; // silently drop the flood
          const room = await roomPromise;
          const u = room.userOf(clientId);
          if (!u) return;
          // Identity and timestamp are stamped HERE — a client can't spoof either.
          const m: ServerMessage = {
            t: 'chat',
            from: clientId,
            name: u.name,
            color: u.color,
            text: msg.text.slice(0, LIMITS.maxChatLen),
            ts: Date.now(),
          };
          room.broadcast(m); // includes the sender: one consistent echo path
          if (this.bus) await this.bus.publish(docId, { kind: 'chat', origin: this.instanceId, msg: m });
          break;
        }
      }
    };

    socket.on('message', (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      // Strict shape validation before any handler sees the frame (guard.ts): malformed
      // ops, oversized fields, and unknown types are dropped here.
      if (!isValidClientMessage(msg)) return;
      // AI runs off the ordered chain: LLM latency must not block this client's edits, and
      // the result is applied by element id, so it needs no ordering against ops.
      if (msg.t === 'ai') {
        if (!aiWindow.allow()) {
          const m: ServerMessage = {
            t: 'ai-result',
            requestId: msg.requestId,
            ok: false,
            error: 'rate limit: try again in a minute',
          };
          socket.send(JSON.stringify(m));
          return;
        }
        void this.handleAI(socket, msg);
        return;
      }
      chain = chain.then(() => handle(msg));
    });

    socket.on('close', () => {
      const n = (this.ipConns.get(ip) ?? 1) - 1;
      if (n <= 0) this.ipConns.delete(ip);
      else this.ipConns.set(ip, n);
      chain = chain.then(async () => {
        if (!roomPromise) return;
        const room = await roomPromise;
        room.remove(clientId);
        await this.broadcastPresence(docId);
        await this.publishLocalPresence(docId);
      });
    });
  }

  /**
   * Run an AI transform and return the result to the requesting socket only. The server
   * does not touch the document — the client applies the result through the CRDT as ops.
   */
  private async handleAI(
    socket: LiveSocket,
    msg: { requestId: string; action: AIAction; text: string },
  ): Promise<void> {
    const reply = (m: ServerMessage): void => socket.send(JSON.stringify(m));
    if (!this.ai) {
      reply({ t: 'ai-result', requestId: msg.requestId, ok: false, error: 'AI service not configured' });
      return;
    }
    try {
      const text = await this.ai.transform(msg.action, msg.text);
      reply({ t: 'ai-result', requestId: msg.requestId, ok: true, text });
    } catch (err) {
      reply({
        t: 'ai-result',
        requestId: msg.requestId,
        ok: false,
        error: err instanceof Error ? err.message : 'AI request failed',
      });
    }
  }

  async whenPersisted(): Promise<void> {
    for (const rp of [...this.rooms.values()]) {
      const room = await rp;
      await room.whenPersisted();
    }
  }
}

export function startServer(port = 0, opts: ServerOptions = {}): Promise<ServerHandle> {
  const store: DocStore = opts.store ?? new InMemoryStore();
  const snapshotEveryOps = opts.snapshotEveryOps ?? 100;
  // Attach to a caller-provided HTTP server (so static files + WS share one port), or bind
  // our own port. When attaching, the caller is expected to have called listen() already.
  const wss = opts.server
    ? new WebSocketServer({ server: opts.server, maxPayload: LIMITS.maxPayloadBytes })
    : new WebSocketServer({ port, maxPayload: LIMITS.maxPayloadBytes });
  const server = new EditorServer(store, snapshotEveryOps, opts.bus, opts.ai);

  wss.on('connection', (socket: LiveSocket, req) => server.attach(socket, req));

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients as Set<LiveSocket>) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  const buildHandle = (boundPort: number): ServerHandle => ({
    port: boundPort,
    roomCount: () => server.roomCount(),
    whenPersisted: () => server.whenPersisted(),
    close: () =>
      new Promise<void>((res) => {
        clearInterval(heartbeat);
        server.whenPersisted().finally(() => {
          for (const socket of wss.clients) socket.terminate();
          // Closes the WS layer only; a caller-provided HTTP server is the caller's to close.
          wss.close(() => res());
        });
      }),
  });

  if (opts.server) {
    const addr = opts.server.address();
    const boundPort = typeof addr === 'object' && addr ? addr.port : port;
    return Promise.resolve(buildHandle(boundPort));
  }
  return new Promise<ServerHandle>((resolve) => {
    wss.on('listening', () => {
      const addr = wss.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve(buildHandle(boundPort));
    });
  });
}
