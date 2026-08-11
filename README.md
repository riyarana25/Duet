# Duet

*A real-time collaborative editor for code **and** prose — built on a hand-written CRDT.*

**[Try it live →](https://collab-editor-kvvw.onrender.com)** open it in two tabs, pick a
name, and type. *(Free hosting sleeps when idle — the first visit takes ~30s to wake.)*

---

Most collaborative editors pick a side: Google Docs for writing, VS Code Live Share for
code. Duet doesn't. One shared document, two ways to see it — flip to **code** for syntax
highlighting, line numbers, and a run button; flip to **doc** for a calm serif writing
surface with markdown formatting. Same text, same collaborators, no mode wars: you can
read it as prose while your friend edits it as code.

Underneath is the part I'm most proud of: the merge engine is a **sequence CRDT written
from scratch** — no Yjs, no Automerge, no operational-transform library. When two people
type into the same word at the same time, both edits survive and every screen converges
to the same result. How that works is explained from first principles in
[logic.md](logic.md).

## What you get

- **Edit together, lose nothing** — concurrent edits merge automatically; there is no
  "last write wins" anywhere in the edit path.
- **See each other** — live cursors and selections in each person's colour, typing
  indicators, click a name to follow their cursor, and a small room chat.
- **A real code editor** — highlighting for 16 languages (auto-detected), autocomplete,
  syntax checking, and a ▶ button that runs Python right in the browser (sandboxed
  CPython via WebAssembly).
- **A real writing surface** — doc mode formats with markdown (toolbar or Ctrl+B/I) and
  renders a live styled preview.
- **AI assist** — select something, hit Explain or Refactor; the result comes back as
  ordinary collaborative edits, so it syncs to everyone like a keystroke.
- **Built to stay up** — documents survive server restarts (snapshot + op log), servers
  scale horizontally over Redis pub/sub, and the public endpoint is rate-limited and
  input-validated end to end.

## Quick start

```bash
npm install
npm run dev        # → http://localhost:9000 (open two tabs to collaborate)
```

Optional: copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY` to enable the AI
panel. Everything else works without it.

## Handy keys

| | |
| --- | --- |
| Share a room | **share** button — the room lives in the URL |
| Run Python | choose `python` (or let auto-detect) → **▶ run** |
| Autocomplete | type 2+ chars → ↑/↓, Enter to accept, Esc to dismiss |
| Format prose | doc mode toolbar, or `Ctrl+B` / `Ctrl+I` → **preview** |
| Word delete | `Ctrl+Backspace` / `Ctrl+Delete` |
| Theme | ☾ / ☼ |

## How it works

```
   Client A ─┐                                    ┌─ Redis pub/sub ─┐
  (CRDT      ├─ WebSocket ─ Server instance N ────┤   (fan-out)      │
   replica)  │              (per-doc room,        └──────────────────┘
   Client B ─┘               op log + presence)          │
                                    │ append / load
                                    ▼
                          Snapshot + op-log store
```

Every client holds a full replica of the document. Local edits become small operations
that apply instantly on your screen and stream to everyone else; the server just stores
and forwards — it never merges, because the data structure makes merging automatic.

The deep dives, if you're curious:

- **[logic.md](logic.md)** — the CRDT, taught from scratch (why concurrent edits can
  merge without a referee).
- **[architecture.md](architecture.md)** — component map and how each layer builds on
  the last: sync → persistence → scaling → AI.
- **[design.md](design.md)** — every frontend decision and its reasoning, including the
  trade-offs we chose *not* to hide.

## Deploy your own

It's one Node process serving HTTP + WebSocket on a single port. A
[Dockerfile](Dockerfile) and [render.yaml](render.yaml) are included — on
[Render](https://render.com), **New → Blueprint** → pick your fork, and you're live in a
few minutes (free plan works).

Abuse protection is built in: per-IP connection caps, op/AI/chat rate limits, strict
message validation, and document size ceilings — see
[src/server/guard.ts](src/server/guard.ts). Volumetric DDoS belongs to the platform/CDN
layer in front; the app handles application-level abuse honestly rather than pretending
to do both.

## Stack

TypeScript (strict) everywhere · hand-rolled RGA CRDT · `ws` WebSockets · snapshot +
op-log persistence · Redis pub/sub scaling · highlight.js + acorn + Pyodide in the
browser · Anthropic API for AI assist · Jest + fast-check property tests (38 green)

```
src/
  crdt/       the CRDT — the heart of the project
  net/        wire protocol shared by client and server
  client/     connection + pluggable transports (node / browser)
  server/     WebSocket server, rooms, stores, message bus, guards
  ai/         AI service interface + Anthropic / mock implementations
  web/        the browser editor (code + doc modes)
```
