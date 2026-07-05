# architecture.md — Component map & data flow

> Living document. Phase 1 establishes only the CRDT core; the network/persistence/scale
> layers below are sketched now and filled in as their phases land.

## Target data flow (end state)

```
   ┌─────────────┐   ops    ┌──────────────┐  ops   ┌──────────────┐  pub/sub  ┌──────────────┐
   │  Client A    │ <──────> │   WS layer    │ <────> │   Server N    │ <──────> │    Redis      │
   │ CRDT replica │          │ (per-doc room)│        │ (room state)  │          │ (fan-out bus) │
   └─────────────┘          └──────────────┘        └──────┬───────┘          └──────────────┘
   ┌─────────────┐                                         │ append / load
   │  Client B    │ <──────> (same room) <──────> Server M  ▼
   │ CRDT replica │                                  ┌──────────────────────┐
   └─────────────┘                                  │ Snapshot + Op-log store│
                                                     └──────────────────────┘
```

- **Client** holds a full CRDT replica ([src/crdt](src/crdt/)). Local edits generate ops,
  applied locally *and* sent up. Remote ops arrive and are `apply()`-ed. Render is a pure
  function of replica state, so the screen always reflects merged state.
- **WS layer / room** groups clients editing one document; broadcasts batched ops.
- **Server instance** owns in-memory room state, persists ops, and (Phase 4) relays via Redis.
- **Redis pub/sub** lets users on *different server instances* in the same room converge.
- **Snapshot + op-log store** gives durability and fast rejoin (snapshot + ops since).

## Phase 1 — CRDT core (done)

- [src/crdt/types.ts](src/crdt/types.ts) — op/state interface contracts (the guardrails).
- [src/crdt/document.ts](src/crdt/document.ts) — RGA implementation of `CRDTDocument`;
  [src/crdt/id.ts](src/crdt/id.ts) — keys + sibling comparator. Property tests prove convergence.
- Self-contained and testable in isolation; no network/persistence/UI dependency.

## Phase 2 — single-server real-time sync (done)

```
ClientConnection (RGADocument + buffer)  --ops/cursor-->  WS server  --relays-->  other clients
        ^  Transport (ws / browser)                          |  Room per docId (op log + presence)
        └------------------ welcome (op log + presence) ------┘
```

- [src/net/protocol.ts](src/net/protocol.ts) — typed frames: `join`/`ops`/`cursor` up,
  `welcome`/`ops`/`presence` down. Ops are the exact Phase-1 `Operation[]`.
- [src/server/wsServer.ts](src/server/wsServer.ts) — connection lifecycle, URL→docId routing,
  heartbeat ping/pong. [src/server/room.ts](src/server/room.ts) — per-doc op log (deduped by
  signature) + presence; **dumb relay**, never merges/reorders (no LWW).
- [src/client/connection.ts](src/client/connection.ts) — buffers local ops, batched flush,
  applies remote ops idempotently, tracks caret as a CRDT element id (survives concurrent
  edits). [src/client/transport.ts](src/client/transport.ts) abstracts the socket so the same
  client runs over `ws` (Node) or the browser's `WebSocket`.
- Catch-up for a (re)joining client = replay welcome ops → CRDT convergence.

## Phase 3 — persistence (done)

- [src/server/store.ts](src/server/store.ts) — `DocStore` interface + `InMemoryStore`;
  [src/server/fileStore.ts](src/server/fileStore.ts) — `FileStore` (snapshot JSON + op-log
  JSONL on disk). The interface is the swap point for a real DB later.
- The Room now materializes a server-side `RGADocument` (applying convergent ops is **not**
  LWW), snapshots every `snapshotEveryOps` accepted ops, and keeps `recentOps` = ops since
  the last snapshot. `welcome` = `persistedSnapshot + recentOps`; the client `load()`s the
  snapshot then replays recent ops → converges. CRDT serialization: `snapshot()`/`load()` in
  [src/crdt/document.ts](src/crdt/document.ts), `DocSnapshot` in [src/crdt/types.ts](src/crdt/types.ts).
- Durable writes are funneled through a **per-room serialized promise queue** so appends and
  snapshot-clears can't interleave. Writes are off the broadcast hot path (durability lags
  delivery, never blocks it). Snapshot-interval tradeoff is documented in store.ts.
- Room hydrates from the store on creation; server `close()` flushes the queue first, so a
  fresh instance pointed at the same `FileStore` dir restores full state.

## Phase 4 — horizontal scaling (done)

### Why WebSockets are stateful, and what that forces

A WebSocket is a long-lived TCP connection pinned to **one** server process. Unlike
stateless HTTP — where a load balancer can send each request to any instance — a socket's
messages always land on the instance that owns the connection. So if Ada is connected to
instance 1 and Alan to instance 2 and they edit the same doc, instance 1 has Ada's ops but
no direct way to reach Alan. The instances must gossip. That cross-instance hop is what the
**MessageBus** (Redis pub/sub in production) provides.

### How it works here

- [src/server/bus.ts](src/server/bus.ts) — `MessageBus` interface (`publish`/`subscribe`/
  `unsubscribe` per docId) + `InMemoryBus` over a shared broker (deterministic tests).
  [src/server/redisBus.ts](src/server/redisBus.ts) — `RedisBus`: two connections (a
  subscriber can't also publish), one channel per doc `editor:doc:<docId>`.
- Each instance, per doc: relays a local client's ops to its **own** sockets AND publishes
  them to the bus. Ops arriving from the bus are `acceptRemote`-ed into the local replica and
  relayed to local sockets, **never re-published**. The bus echoes a publish back to its
  sender, so every instance **drops messages whose `origin` is its own `instanceId`** — that
  plus CRDT op dedup means no loops and no double-apply.
- **Presence across instances:** each instance publishes its *local* presence snapshot; peers
  cache it per-origin and render the **union** (local + all remote) to their sockets. A
  joining client triggers a `presence-request` so peers re-announce.

### Persistence under scale (the tricky part)

With a **shared store** (one DB / op log for all instances), each op must be written exactly
once. We do that by persisting **only locally-originated ops** (`acceptLocal` persists;
`acceptRemote` does not). The op log is append-only, so concurrent appends from different
instances are safe. Auto-**snapshots are disabled** in multi-instance mode, because snapshot
+ log-truncation across instances would race (one instance could truncate ops another hasn't
folded in). Safe distributed snapshotting needs per-doc ownership / leader election — noted
as future work; the append-only log keeps durability correct without it.

## Phase 5 — AI assist (done)

```
Client selects [start,end) → requestAI(action, text) ──ai──▶ Server ──▶ AIService (Anthropic)
        ▲ result applied through CRDT (deleteElement + insertAfter)   │
        └──────────────────────── ai-result ◀──────────────────────────┘
```

- [src/ai/aiService.ts](src/ai/aiService.ts) — `AIService` interface + `AIAction`.
  [src/ai/mockService.ts](src/ai/mockService.ts) (tests), [src/ai/anthropicService.ts](src/ai/anthropicService.ts)
  (real, `claude-opus-4-8`, server-side so the key never reaches the browser).
- Protocol: `ai` (client→server: action + selected text) / `ai-result` (server→client).
  Handled **off the ordered message chain** in [wsServer.ts](src/server/wsServer.ts) — LLM
  latency must not block the client's edits, and the result is id-anchored so it needs no
  ordering against ops.
- **Result re-enters as ops, not a mutation:** the client captures the selection as element
  ids, then tombstones each (`deleteElement`) and inserts the result after the left-anchor
  (`insertAfter`). Insert lamports beat the tombstoned ids, so the replacement renders exactly
  where the selection was (logic.md §5) and **converges on every peer** — the AI edit is real
  collaborative state, fully subject to the same no-LWW guarantees as a keystroke.

## Browser editor (done)

```
public/index.html ──loads──▶ public/bundle.js (esbuild of src/web/main.ts)
                                     │ mountEditor()
   contenteditable .doc  ◀──render── ClientConnection (browser transport) ──ops──▶ server
        │ beforeinput (preventDefault)        ▲ 'change'/'presence' events
        └─ translate keystroke → CRDT op ─────┘   overlay: remote carets + labels
```

- **Controlled contenteditable** ([src/web/editor.ts](src/web/editor.ts)): the DOM is never
  authoritative. `beforeinput`/`paste` are intercepted, translated into CRDT ops, and the
  surface is re-rendered from `conn.text()`. Caret is tracked as an element id (survives
  remote edits); remote cursors are an overlay drawn from `Range` rects.
- **Browser-safe client:** the shared [ClientConnection](src/client/connection.ts) dropped
  its Node deps — [src/util/emitter.ts](src/util/emitter.ts) replaces Node `events`,
  [src/util/id.ts](src/util/id.ts) replaces `crypto.randomUUID`, and
  [transport.browser.ts](src/client/transport.browser.ts) uses the global `WebSocket`. Same
  class runs in Node tests and the browser.
- **Build/serve:** esbuild bundles `src/web/main.ts` → `public/bundle.js`; a second tsconfig
  ([tsconfig.web.json](tsconfig.web.json), DOM lib) typechecks the web graph (the Node
  tsconfig excludes it). [src/server/main.ts](src/server/main.ts) serves `public/` and
  attaches the WS server to the same HTTP server (`ServerOptions.server`).

## Open items / deferred

- Tombstone garbage collection (safe only once all replicas have seen a delete) — deferred.
- Op batching/compaction strategy — Phase 2/3.
- Snapshot interval tradeoff — Phase 3.
