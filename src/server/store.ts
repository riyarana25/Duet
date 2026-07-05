/**
 * DocStore — durable persistence for a document: a periodic snapshot plus an append-only
 * op log of everything accepted since that snapshot. (Phase 3.)
 *
 * Rejoin model: a (re)joining client receives `snapshot + ops-since-snapshot` and replays
 * them onto a fresh replica → CRDT convergence (logic.md §7). The snapshot bounds how far
 * back the op log must reach.
 *
 *   Snapshot-interval tradeoff (why N is tunable):
 *   - Snapshot often (small N): tiny op log ⇒ fast rejoin, low memory, but frequent
 *     (whole-state) writes ⇒ more I/O and write amplification.
 *   - Snapshot rarely (large N): cheap steady state, but a long op log ⇒ slower catch-up,
 *     more memory, and more work lost-window if a write is interrupted.
 *   The sweet spot depends on doc size vs. edit rate; we expose it as `snapshotEveryOps`.
 */
import { DocSnapshot, Operation } from '../crdt/types';

export interface LoadedDoc {
  /** Latest persisted snapshot, or null if the doc has never been snapshotted. */
  snapshot: DocSnapshot | null;
  /** Ops appended after the snapshot (in order). Empty if fully snapshotted. */
  ops: Operation[];
}

export interface DocStore {
  /** Load snapshot + ops-since-snapshot for a document. */
  loadDocument(docId: string): Promise<LoadedDoc>;
  /** Append newly-accepted ops to the durable op log. */
  appendOps(docId: string, ops: Operation[]): Promise<void>;
  /** Persist a snapshot; the op log it subsumes is cleared. */
  saveSnapshot(docId: string, snapshot: DocSnapshot): Promise<void>;
}

/** Volatile store for tests / single-process dev. Loses everything on restart. */
export class InMemoryStore implements DocStore {
  private readonly snapshots = new Map<string, DocSnapshot>();
  private readonly logs = new Map<string, Operation[]>();

  async loadDocument(docId: string): Promise<LoadedDoc> {
    return {
      snapshot: this.snapshots.get(docId) ?? null,
      ops: [...(this.logs.get(docId) ?? [])],
    };
  }

  async appendOps(docId: string, ops: Operation[]): Promise<void> {
    const log = this.logs.get(docId) ?? [];
    log.push(...ops);
    this.logs.set(docId, log);
  }

  async saveSnapshot(docId: string, snapshot: DocSnapshot): Promise<void> {
    this.snapshots.set(docId, snapshot);
    this.logs.set(docId, []); // snapshot subsumes the prior log
  }
}
