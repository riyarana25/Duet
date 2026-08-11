/**
 * CRDT type contracts — the guardrails for the whole edit path.
 *
 * These interfaces are written first and everything else implements against them.
 * The algorithm they encode is specified in ../../logic.md (read that to learn WHY).
 *
 * Hard rules enforced here by construction:
 *  - No array indexes anywhere in an operation. Edits address immortal element ids.
 *  - Delete is a tombstone (an id), never a removal.
 *  - The only two ops are insert and delete; everything else (replace, AI rewrite)
 *    is expressed as a sequence of these.
 */

/**
 * A globally-unique, immortal identity for a single character element.
 * Unique without coordination: `site` differs across replicas, `counter`
 * is per-site monotonic. See logic.md §2.
 */
export interface ElementId {
  /** Unique id of the replica that CREATED this element. */
  readonly site: string;
  /** Per-site monotonic counter; increments once per element this site creates. */
  readonly counter: number;
}

/** Canonical string form of an ElementId, used as Map/Set keys: `site#counter`. */
export type ElementKey = string;

/**
 * One character in the document. Elements are never moved and never physically
 * removed (delete tombstones them). See logic.md §2–§4.
 */
export interface Element {
  readonly id: ElementId;
  /** Exactly one character. */
  readonly value: string;
  /**
   * The id of the element this one was inserted immediately after (its left
   * neighbour at insert time). `null` means "inserted at the very start"
   * (child of the virtual root). This pointer defines tree structure.
   */
  readonly originId: ElementId | null;
  /** Lamport timestamp at creation; primary key of the sibling tiebreak. */
  readonly lamport: number;
}

export interface InsertOp {
  readonly type: 'insert';
  readonly id: ElementId;
  readonly value: string;
  readonly originId: ElementId | null;
  readonly lamport: number;
}

export interface DeleteOp {
  readonly type: 'delete';
  /** Id of the element to tombstone. */
  readonly id: ElementId;
  /** Advances Lamport clocks on receipt; not used for ordering. */
  readonly lamport: number;
}

export type Operation = InsertOp | DeleteOp;

/** A visible character with its stable id — used for cursor anchoring and index mapping. */
export interface VisibleChar {
  readonly id: ElementId;
  readonly value: string;
}

/**
 * A serializable snapshot of full CRDT state — every element (tombstoned included) plus
 * the tombstone set. This is what gets persisted. Rendering-only state would lose the
 * ids/tombstones future concurrent ops need, so everything is snapshotted.
 */
export interface DocSnapshot {
  readonly elements: Element[];
  readonly deleted: ElementKey[];
}

/**
 * The replicated document state and the operations over it.
 *
 * Convergence contract (proved by property tests, logic.md §7):
 *   For any two Documents that have applied the same set of ops,
 *   `text()` is identical — independent of apply order and of duplicates.
 *
 * `apply` MUST be commutative and idempotent. `generateInsert`/`generateDelete`
 * are the LOCAL author path: they mint ids + Lamport stamps and return the op
 * (which the caller also broadcasts). Remote ops arrive via `apply`.
 */
export interface CRDTDocument {
  /** Apply an op (local or remote). Commutative + idempotent. Returns the op applied. */
  apply(op: Operation): void;

  /**
   * Author a local insert of `value` at visible position `index`
   * (0 = before first visible char, text().length = at end). Throws on out-of-range index.
   */
  generateInsert(index: number, value: string): InsertOp;

  /** Author a local delete of the visible character at `index`. Throws on out-of-range index. */
  generateDelete(index: number): DeleteOp;

  /**
   * Author an insert directly after element `originId` (null = doc start) — the id-based
   * primitive used when a stable anchor matters (e.g. AI replacements).
   */
  insertAfter(originId: ElementId | null, value: string): InsertOp;

  /** Author a delete (tombstone) of a specific element id, regardless of its position. */
  deleteElement(id: ElementId): DeleteOp;

  /** The current visible document text (tombstones excluded). */
  text(): string;

  /**
   * Visible characters in document order, each with its stable element id.
   * A caret "at index i" is anchored to the id at i-1 (null at the start), so a cursor
   * stays glued to the right character as concurrent edits shift positions.
   */
  visibleElements(): ReadonlyArray<VisibleChar>;

  /** Serialize full state (all elements + tombstones) for persistence. */
  snapshot(): DocSnapshot;

  /** Replace state from a snapshot (advances the Lamport clock past it). */
  load(snapshot: DocSnapshot): void;

  /** This replica's site id. */
  readonly site: string;
}
