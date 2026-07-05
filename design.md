# design.md — Frontend design decisions

> Living document. The brief evolved: the first build was an editorial *writing* surface
> (serif, paper, prose); it has since pivoted to a **collaborative code editor** — the
> CRDT story lands harder as "Google Docs for code." The principles carried over; the
> surface changed. Superseded decisions are kept below for the record.

## Direction (current)

- **Tone:** quiet, terminal-adjacent, code-first. The code is the interface; chrome stays
  minimal (one header row, one status bar). Not a generic SaaS dashboard, not a stock
  slate-gray IDE clone.
- **Typography:** system monospace stack everywhere — including the chrome — for a coherent
  editor identity. No web-font load, no layout shift.
- **Palette:** dark-first, warm near-monochrome + **one** amber accent. The warm undertone
  is inherited from the original paper design and is what keeps it from looking like every
  default dark theme. A light theme mirrors the same values; a toggle persists the choice.
- **Live cursors:** each remote user gets a distinct, stable color + a name label,
  chosen by the user at join.

## Decisions made (current build — [public/styles.css](public/styles.css), [src/web/](src/web/))

- **Join screen, not auto-drop-in.** Name, cursor colour (7 swatches), and room are chosen
  before connecting; name/colour persist in localStorage, the room lands in the URL so a
  session is shareable by link. Rationale: presence is the product — an identity you picked
  makes the live-cursor demo legible ("that's really Alan"), where a random default name
  undermined it.
- **Highlight underlay, not a rich-text DOM.** The contenteditable keeps ONE plain text
  node with `color: transparent` (it owns caret, selection, and input); a `.highlight`
  layer behind it paints the same text with token colours. Rationale: all the
  caret/selection math assumes a single text node; this adds syntax colour without
  touching any of it. Alignment is guaranteed by shared font metrics.
- **Tokenizing is outsourced; the architecture is not.** Highlighting uses highlight.js
  (16 grammars registered individually, auto-detect debounced + cached, plus a manual
  language picker). A first hand-rolled tokenizer was replaced deliberately: language
  grammars are commodity work, and the no-library rule exists to prove out the CRDT, not
  to hand-write the world. The token *palette* stays ours — no hljs theme import; colours
  map onto the same warm variables as everything else.
- **Diagnostics, same outsourcing rule.** "Does it compile?" is answered by acorn for
  JavaScript and the platform's `JSON.parse` for JSON — full syntax validation via a small
  trusted parser, shown as ✓/✗ + line in the status bar (debounced with detection, never
  per keystroke). Languages without a cheap in-browser parser show nothing rather than a
  fake green check.
- **Filename tab.** The chrome shows `room.ext` (e.g. `hello.py`) like an editor tab —
  the extension follows the detected/selected language, `.md` in doc mode. Presence chips
  and a colour-coded status bar (diagnostics, language, sync state) carry the live-ness.
- **Trailing-newline sentinel.** A caret after a final `\n` has no line box, so browsers
  draw it at the end of the previous line (press Enter → gutter grows, caret doesn't
  move). Render fix: when the model text ends with `\n`, the DOM gets ONE extra `\n` so
  the last line exists; all model↔DOM index mapping clamps to the model length, so the
  sentinel is invisible to editing and to peers.
- **Run = real execution, honestly scoped.** ▶ Run executes the document as Python via
  Pyodide (actual CPython in WebAssembly) inside a Web Worker: no DOM access, off the main
  thread, hard-terminated on timeout so an infinite loop costs seconds, not the tab. The
  worker stays warm between runs (the runtime is a one-time ~10 MB CDN download). The
  button only appears for Python — languages we can't genuinely run don't get a fake one.
- **Autocomplete without an LSP.** Word-based completion — the active language's keywords
  plus identifiers already present in the document, prefix-matched at the caret. No
  server, no language service; on demo-sized documents it covers most of what completion
  is actually used for (names you already typed). Menu keys: ↑/↓, Enter/Tab, Esc.
- **Formatting is markdown in the text, not attributed rich text.** The CRDT is a
  plain-character sequence, so bold/headings live in the document as markdown syntax
  (toolbar + Ctrl+B/I insert it; a preview toggle renders it via a small escape-first
  renderer, [src/web/markdown.ts](src/web/markdown.ts)). This is the honest design given
  the data model: formatting collaborates like any keystroke, with zero changes to the
  CRDT. True attributed rich text (formatting ranges that survive concurrent edits) is a
  known hard problem — Peritext-style mark CRDTs — and is explicitly future work, not
  something to fake with HTML in a character sequence.
- **Two view modes over one shared text.** `code` (mono, gutter, highlight, no wrap) and
  `doc` (serif, wrapped, focused column — the original editorial design lives on here).
  Mode is a per-client rendering choice: peers can view the same document differently and
  still converge, because the CRDT text is the source of truth either way. The status bar
  and AI verbs follow the mode (Ln/Col + Explain/Refactor vs word count + Summarize/Improve).
- **No line wrap ⇒ trivial gutter.** `white-space: pre` + horizontal scroll means visual
  lines equal logical lines, so the line-number gutter is just "1..N at the shared
  line-height" — no per-line measurement, always aligned.
- **Code-editor table stakes:** Tab inserts two spaces; Enter copies the current line's
  leading whitespace (auto-indent); Ln/Col + peers + sync state in a fixed status bar.
- **AI verbs reframed:** the panel reads **Explain / Refactor** (code-flavoured), mapped to
  the existing wire actions (`summarize`/`improve`) so protocol, server, and tests are
  untouched. Explain prepends `//` comments and keeps the code; Refactor rewrites in place.
  Results still re-enter as CRDT ops.

## Superseded (first build — editorial writing surface)

Kept for the record; the reasoning still informs the current look.

### AI assist panel — original interaction & placement rationale

The AI feature's *interaction model* was fixed before the DOM existed, and the visual
treatment followed from it (the interaction model survives the pivot unchanged):

- **Selection-driven, not a chatbox.** The panel acts on the current selection
  (`transformSelection(action, start, end)`); there is no free-form prompt. This keeps the
  document the subject and the AI a quiet tool, not a second conversation competing for focus.
- **Two verbs only — Summarize / Improve.** Minimal surface; both replace the selection in
  place, so the result reads as an edit to *your* document, not an external suggestion card.
- **Result is a normal edit.** Because the output re-enters as CRDT ops, it shows up with the
  same live-cursor/undo semantics as typing — no special "AI block" chrome to design around.
- **Placement (when the DOM lands):** a slim right-hand rail or a small popover anchored to
  the selection, in the restrained palette with the single accent reserved for the action
  buttons. No modal, no full-height sidebar — the AI must never push the writing column around.

### Decisions of the editorial build (replaced by the code-editor look above)

- **Typeface:** body is a system *serif* stack (Iowan Old Style → Palatino → Georgia → serif)
  at 19px / 1.7 line-height. Rationale: a serif signals "writing surface," reads well for long
  passages, and the stack uses high-quality fonts already on the OS (no web-font load, no
  layout shift). Chrome (peer list, AI bar) uses a small sans for contrast — it's UI, not prose.
- **Palette:** near-monochrome — warm paper `#faf9f7`, ink `#1f1d1a`, muted `#8a857c`, hairline
  rule `#e7e3dc`. Exactly **one accent**, amber `#b45309`, allowed only on AI-button hover and
  the local caret hint. No gradients, no cards, no rounded-2xl. The document is the only thing
  with visual weight; the sticky chrome fades into the paper via a gradient mask.
- **Live cursors:** each user gets a stable color from a 7-hue editorial palette (deep amber,
  blue, green, magenta, violet, teal, ochre) assigned at join; the caret is a 2px bar with a
  small color-matched name pill above it. Colors are saturated enough to read against paper
  while staying out of the prose's way. (Per-user contrast is not yet WCAG-audited — a known
  follow-up.)
- **AI panel:** a slim inline bar in the chrome (Summarize / Improve + a status word), acting
  on the current selection — not a chatbox, not a sidebar that reflows the column.
