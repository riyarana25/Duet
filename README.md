# Collaborative Document Editor

A real-time collaborative editor — many people editing one document at once, seeing
each other's cursors live, never losing an edit — built around a **hand-written sequence
CRDT** (RGA-style). No Yjs, Automerge, ShareDB, or any off-the-shelf CRDT/OT library: the
merge algorithm is implemented from scratch and documented in [logic.md](logic.md).

There's also an AI assist panel that can summarize or rewrite a selection, with the result
inserted back **through the CRDT** as ordinary operations, so it converges on every peer
just like a keystroke.

## Features

- **Conflict-free concurrent editing** — an RGA CRDT where every character has a unique,
  immortal id, inserts reference the character they follow, and deletes are tombstones.
  Operations are commutative and idempotent, so replicas converge regardless of arrival
  order or duplicates. No last-write-wins anywhere in the edit path.
- **Live presence** — see who's in the document and where their cursor is, anchored to
  CRDT ids so a remote caret stays glued to the right character as text shifts.
- **Durable & resumable** — periodic snapshots plus an append-only op log; rejoin or a
  full server restart replays snapshot + recent ops back to a consistent state.
- **Horizontally scalable** — a pub/sub message bus (Redis in production, in-memory for
  tests) fans ops and presence across server instances so users on different processes
  still converge.
- **AI assist** — select text, then summarize or improve it via the Anthropic API. The key
  stays server-side; the result re-enters the document as CRDT ops.
- **Browser editor** — a controlled `contenteditable` surface where the CRDT is the single
  source of truth, with live remote cursors and an editorial, document-first UI.

## Architecture

```
   Client A ─┐                                    ┌─ Redis pub/sub ─┐
  (CRDT      ├─ WebSocket ─ Server instance N ────┤   (fan-out)      │
   replica)  │              (per-doc room,        └──────────────────┘
   Client B ─┘               op log + presence)          │
                                    │ append / load
                                    ▼
                          Snapshot + op-log store
```

Each client holds a full CRDT replica; local edits become ops that are applied locally and
sent up. The server is a **dumb relay** — it stores and forwards ops, never merges or
reorders them; convergence is the CRDT's job. Rendering is a pure function of replica
state, so the screen always reflects merged state.

For the full picture:

- **[logic.md](logic.md)** — the CRDT algorithm explained from first principles (why
  concurrent edits merge without data loss). Start here.
- **[architecture.md](architecture.md)** — component map and data flow across all layers.
- **[design.md](design.md)** — frontend design decisions and their rationale.

## Tech stack

- **TypeScript** (strict) everywhere
- **CRDT:** hand-rolled RGA — no external CRDT/OT libraries
- **Transport:** `ws` WebSockets, one room per document
- **Persistence:** snapshot + op-log store (in-memory or filesystem)
- **Scale:** Redis pub/sub fan-out between instances
- **AI:** Anthropic API (`@anthropic-ai/sdk`)
- **Tests:** Jest + ts-jest, with property-based tests via fast-check
- **Web build:** esbuild bundle, served alongside the WebSocket server

## Getting started

```bash
npm install
cp .env.example .env   # then edit .env if you want (Windows: copy .env.example .env)
npm run dev            # builds server + web bundle, then serves on http://localhost:9000
```

Open `http://localhost:9000` in two browser tabs to collaborate.

Configuration is read from a local `.env` file (loaded automatically via dotenv); see
[.env.example](.env.example) for all options. The main ones:

- `PORT` — the port to serve on (default `9000`). On Windows some ranges are reserved by
  the OS — `8080` in particular often fails with `EACCES`, so this project defaults to
  `9000`. Pick any free port outside the reserved ranges if needed.
- `ANTHROPIC_API_KEY` — enables the AI assist panel (Summarize / Improve). Without it the
  editor runs normally and the AI panel just returns a "not configured" error.

You can also pass these through the shell instead of a `.env` file, e.g.
`$env:PORT = "9000"; npm run dev` (PowerShell) or `PORT=9000 npm run dev` (bash).

## Development

| Task            | Command                                         |
| --------------- | ----------------------------------------------- |
| Install         | `npm install`                                   |
| Build (server)  | `npm run build`                                 |
| Build (web)     | `npm run build:web`                             |
| Typecheck       | `npm run typecheck`                             |
| Test            | `npm test`                                       |
| Test (watch)    | `npm run test:watch`                            |

The test suite includes property-based checks that apply random operation orderings and
assert every replica converges to identical state, plus integration tests for the sync
server, persistence across restart, cross-instance fan-out, and the AI path. A couple of
tests are gated on external services (`REDIS_URL`, `ANTHROPIC_API_KEY`) and skip when those
aren't set.

## Project structure

```
src/
  crdt/       the RGA CRDT — types, document, id ordering, property tests
  net/        wire protocol shared by client and server
  client/     ClientConnection + pluggable transports (node / browser)
  server/     WebSocket server, per-doc room, stores, message bus
  ai/         AIService interface + Anthropic and mock implementations
  web/        browser editor (controlled contenteditable)
  util/       environment-neutral emitter + id helpers
public/       static assets and the built browser bundle
```
