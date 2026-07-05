# Collaborative Code Editor

A real-time collaborative code editor — many people editing one document at once, seeing
each other's cursors live, never losing an edit — built around a **hand-written sequence
CRDT** (RGA-style). No Yjs, Automerge, ShareDB, or any off-the-shelf CRDT/OT library: the
merge algorithm is implemented from scratch and documented in [logic.md](logic.md).

There's also an AI assist panel that can explain or refactor a selection, with the result
inserted back **through the CRDT** as ordinary operations, so it converges on every peer
just like a keystroke.

## Features

- **Conflict-free concurrent editing** — an RGA CRDT where every character has a unique,
  immortal id, inserts reference the character they follow, and deletes are tombstones.
  Operations are commutative and idempotent, so replicas converge regardless of arrival
  order or duplicates. No last-write-wins anywhere in the edit path.
- **Live presence** — see who's in the document, their cursor, and their **selection**
  (translucent colour highlight), all anchored to CRDT ids so they stay glued to the
  right characters as text shifts. Peer chips pulse while someone is typing, and
  clicking a chip **follows** their cursor around the document.
- **Room chat** — an ephemeral per-room chat panel (unread badge, identity stamped
  server-side, rate-limited, relayed across instances via the message bus).
- **Durable & resumable** — periodic snapshots plus an append-only op log; rejoin or a
  full server restart replays snapshot + recent ops back to a consistent state.
- **Horizontally scalable** — a pub/sub message bus (Redis in production, in-memory for
  tests) fans ops and presence across server instances so users on different processes
  still converge.
- **AI assist** — select code, then Explain or Refactor it via the Anthropic API (in doc
  mode: Summarize / Improve). The key stays server-side; the result re-enters the document
  as CRDT ops.
- **Browser editor, code-first** — a controlled `contenteditable` surface where the CRDT
  is the single source of truth: syntax highlighting (highlight.js, auto-detected or
  picked from 16 languages), live syntax checking (acorn for JS, native for JSON) in the
  status bar, line numbers, a filename tab that follows the language (`hello.py`), live
  remote cursors, a join screen for picking your name/colour/room, and dark + light
  themes. A **doc mode** toggle renders the same shared text as a serif writing surface
  for prose.
- **Run Python in the browser** — a ▶ Run button executes the document as real CPython
  (Pyodide/WebAssembly) in a sandboxed Web Worker with a hard timeout; stdout and
  tracebacks land in an output panel. First run downloads the runtime (~10 MB, cached).
- **Autocomplete & editing niceties** — word-based completion (language keywords +
  identifiers already in the doc, arrows/Enter/Tab/Esc), Tab indent, Enter auto-indent,
  Ctrl+Backspace / Ctrl+Delete word deletion.
- **Doc mode is a Markdown surface** — H1/H2/bold/italic/code/list toolbar (and
  Ctrl+B / Ctrl+I) writing markdown into the shared text, plus a live **preview** toggle
  rendering styled headings/emphasis (safe hand-rolled renderer, escape-first). Because
  formatting lives in the text, it collaborates exactly like code.
- **Share & join** — the room lives in the URL: hit **share** to copy the link, send it,
  and whoever opens it lands in the same document. The join screen can mint a random
  room for a fresh private space.
- **Abuse guards for public deployment** — per-IP connection caps, per-connection op and
  AI rate limits, strict frame/op validation, document size caps, payload limits (see
  Security below).

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
- **Highlighting:** highlight.js (grammars only — the editor surface around it is custom)
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

## Deploying

The app is a single Node process serving HTTP + WebSocket on one port, so any host with
WebSocket support works (Render, Railway, Fly.io — not static hosts). A
[Dockerfile](Dockerfile) and a [render.yaml](render.yaml) blueprint are included:

1. Push the repo to GitHub.
2. On [Render](https://render.com): **New → Blueprint**, point it at the repo — it picks
   up `render.yaml` and builds the Dockerfile (free plan works; it sleeps when idle and
   cold-starts in ~30s).
3. Optionally set `ANTHROPIC_API_KEY` in the service's environment to enable AI assist.

Share the resulting URL with `?doc=room-name` and collaborate.

## Security posture

App-level protections (see [src/server/guard.ts](src/server/guard.ts)):

- **Strict frame validation** — every inbound message is shape-checked before any handler
  runs; malformed ops are dropped. Inserts must carry exactly one character, so oversized
  payloads can't be smuggled past the op rate limit.
- **Rate limits** — per-connection sliding windows on CRDT ops (20k/10s — generous for
  humans, tight for scripts) and AI requests (6/min, plus a selection-length cap, since
  each call costs real money).
- **Connection caps** — per-IP socket limit (reads `x-forwarded-for` behind a proxy),
  per-room participant limit, and a cap on rooms per instance.
- **Size caps** — WebSocket frames limited via `maxPayload`; documents refuse ops past an
  element ceiling; presence names/ids are length-clamped and control-chars stripped.
- **Key hygiene** — the Anthropic key never reaches the browser; AI runs server-side.
- **Headers** — `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` on all
  static responses.

Honest boundary: **volumetric DDoS** (packet/connection floods) cannot be solved in
application code — that layer belongs to the platform's edge or a CDN (e.g. put
Cloudflare in front of the deployment). The measures above handle *application-level*
abuse: op floods, AI cost abuse, memory exhaustion, and malformed input.

## Project structure

```
src/
  crdt/       the RGA CRDT — types, document, id ordering, property tests
  net/        wire protocol shared by client and server
  client/     ClientConnection + pluggable transports (node / browser)
  server/     WebSocket server, per-doc room, stores, message bus
  ai/         AIService interface + Anthropic and mock implementations
  web/        browser editor (controlled contenteditable, code + doc modes)
  util/       environment-neutral emitter + id helpers
public/       static assets and the built browser bundle
```
