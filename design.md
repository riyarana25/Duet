# design.md — Frontend design decisions

> Living document. The UI does not exist until Phase 2; this records the *direction* and
> will gain concrete justifications (with rationale) as components are built. The brief:
> a **writing surface**, editorial and calm — not a generic SaaS dashboard.

## Direction (committed)

- **Tone:** editorial, calm, document-first. The text is the interface; chrome stays quiet.
- **Typography:** a real serif (or a refined, non-default sans) for body text. Explicitly
  **not** Inter-on-purple-gradient. Body text optimized for reading long passages.
- **Palette:** restrained near-monochrome + **one** accent color. No hero gradients.
- **Layout:** generous whitespace, single focused column. No rounded-2xl card soup.
- **Live cursors:** each remote user gets a distinct, stable color + a name label.

## AI assist panel (Phase 5) — interaction & placement rationale

The current build is headless (no DOM yet), but the AI feature's *interaction model* is
already fixed by the implementation, and the visual treatment follows from it:

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

## Decisions made (built — [public/styles.css](public/styles.css), [src/web/editor.ts](src/web/editor.ts))

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
