/**
 * RGADocument — a hand-written RGA sequence CRDT (logic.md is the spec).
 *
 * State is just: a map of elements (by id) + a set of tombstoned ids. The visible text
 * is a pure function of that state (linearize()), recomputed each render. Because render
 * never depends on insertion order, and because inserts are keyed-by-id (idempotent) and
 * deletes are set-membership (idempotent + commutative even with their own insert),
 * apply() is commutative and idempotent. That is the convergence guarantee. logic.md §7.
 */
import {
  CRDTDocument,
  DeleteOp,
  DocSnapshot,
  Element,
  ElementId,
  ElementKey,
  InsertOp,
  Operation,
} from './types';
import { compareSiblings, keyOf } from './id';

export class RGADocument implements CRDTDocument {
  /** All elements ever seen, by canonical key. Never deleted from (tombstones live on). */
  private readonly elements = new Map<ElementKey, Element>();
  /** Tombstone set: an element is invisible iff its key is in here. logic.md §4. */
  private readonly deleted = new Set<ElementKey>();
  /** Lamport clock for this replica. logic.md §6. */
  private clock = 0;
  /** Per-site counter for minting fresh element ids. logic.md §2. */
  private nextCounter = 0;

  constructor(public readonly site: string) {}

  /** Build a replica directly from a persisted snapshot. */
  static fromSnapshot(site: string, snapshot: DocSnapshot): RGADocument {
    const d = new RGADocument(site);
    d.load(snapshot);
    return d;
  }

  // ---- Authoring local ops (also applied locally; returned for broadcast) ----

  generateInsert(index: number, value: string): InsertOp {
    const vis = this.visible();
    if (index < 0 || index > vis.length) {
      throw new RangeError(`insert index ${index} out of range [0, ${vis.length}]`);
    }
    // Origin = the visible element immediately to the left; null means doc start.
    const originId: ElementId | null = index === 0 ? null : vis[index - 1]!.id;
    return this.insertAfter(originId, value);
  }

  generateDelete(index: number): DeleteOp {
    const vis = this.visible();
    if (index < 0 || index >= vis.length) {
      throw new RangeError(`delete index ${index} out of range [0, ${vis.length})`);
    }
    return this.deleteElement(vis[index]!.id);
  }

  /**
   * Author an insert directly after element `originId` (null = doc start) — the id-based
   * primitive. Index-based generateInsert is a thin wrapper over it. Used by the AI assist
   * path so a replacement anchors to stable ids, not positions that concurrent edits shift.
   */
  insertAfter(originId: ElementId | null, value: string): InsertOp {
    if (value.length !== 1) {
      throw new Error(`insertAfter expects exactly one character, got ${JSON.stringify(value)}`);
    }
    const lamport = ++this.clock;
    const id: ElementId = { site: this.site, counter: this.nextCounter++ };
    const op: InsertOp = { type: 'insert', id, value, originId, lamport };
    this.ingest(op);
    return op;
  }

  /** Author a delete (tombstone) of a specific element id — robust to concurrent shifts. */
  deleteElement(id: ElementId): DeleteOp {
    const lamport = ++this.clock;
    const op: DeleteOp = { type: 'delete', id, lamport };
    this.ingest(op);
    return op;
  }

  // ---- Applying ops (local or remote): commutative + idempotent ----

  apply(op: Operation): void {
    this.ingest(op);
    // Advance the Lamport clock on receipt so locally-authored ops stay causally ahead.
    this.clock = Math.max(this.clock, op.lamport) + 1;
  }

  /**
   * The state mutation, with no clock side-effect. Idempotent by construction:
   *  - insert: skip if the id already exists (re-inserts are no-ops).
   *  - delete: Set.add is naturally idempotent, and tolerates the insert not being
   *    present yet (the element is simply born tombstoned). logic.md §4.
   */
  private ingest(op: Operation): void {
    if (op.type === 'insert') {
      const k = keyOf(op.id);
      if (!this.elements.has(k)) {
        this.elements.set(k, {
          id: op.id,
          value: op.value,
          originId: op.originId,
          lamport: op.lamport,
        });
      }
    } else {
      this.deleted.add(keyOf(op.id));
    }
  }

  // ---- Rendering ----

  text(): string {
    let s = '';
    for (const el of this.visible()) s += el.value;
    return s;
  }

  visibleElements(): ReadonlyArray<{ id: ElementId; value: string }> {
    return this.visible().map((el) => ({ id: el.id, value: el.value }));
  }

  /** Total elements ever applied, tombstones included (size/abuse caps, metrics). */
  elementCount(): number {
    return this.elements.size;
  }

  // ---- persistence ----

  /** Serialize full state (all elements + tombstones) for snapshotting. logic.md §4. */
  snapshot(): DocSnapshot {
    return {
      elements: [...this.elements.values()],
      deleted: [...this.deleted],
    };
  }

  /**
   * Replace state from a snapshot. Advances the Lamport clock past everything in the
   * snapshot so that ops this replica subsequently authors sort AFTER the loaded content
   * (logic.md §6). The per-site counter is untouched: this replica's site is unique, so
   * its fresh ids never collide with loaded ones.
   */
  load(snapshot: DocSnapshot): void {
    this.elements.clear();
    this.deleted.clear();
    let maxLamport = 0;
    for (const el of snapshot.elements) {
      this.elements.set(keyOf(el.id), el);
      if (el.lamport > maxLamport) maxLamport = el.lamport;
    }
    for (const k of snapshot.deleted) this.deleted.add(k);
    this.clock = Math.max(this.clock, maxLamport + 1);
  }

  /** Visible elements in document order (tombstones filtered out). */
  private visible(): Element[] {
    return this.linearize().filter((el) => !this.deleted.has(keyOf(el.id)));
  }

  /**
   * Total order over all elements (tombstones included) via RGA tree linearization:
   * group by origin, sort each sibling group by compareSiblings, pre-order DFS from root.
   * Iterative (explicit stack) so a long left-to-right chain can't overflow the call
   * stack. Recomputed per call — correctness over speed; optimize later if it's ever
   * a bottleneck. logic.md §5.
   */
  private linearize(): Element[] {
    // childrenByOrigin: origin key (null = virtual root) -> its child elements.
    const childrenByOrigin = new Map<ElementKey | null, Element[]>();
    for (const el of this.elements.values()) {
      const ok: ElementKey | null = el.originId ? keyOf(el.originId) : null;
      const arr = childrenByOrigin.get(ok);
      if (arr) arr.push(el);
      else childrenByOrigin.set(ok, [el]);
    }
    for (const arr of childrenByOrigin.values()) arr.sort(compareSiblings);

    const out: Element[] = [];
    const stack: Element[] = [];
    const pushReversed = (kids: Element[] | undefined): void => {
      if (!kids) return;
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
    };
    pushReversed(childrenByOrigin.get(null));
    while (stack.length > 0) {
      const el = stack.pop()!;
      out.push(el);
      pushReversed(childrenByOrigin.get(keyOf(el.id)));
    }
    // An element whose origin hasn't been applied yet is unreachable from root and omitted
    // until it arrives; a causally-complete op set never dangles, so the render is total.
    return out;
  }
}
