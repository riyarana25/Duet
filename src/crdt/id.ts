/**
 * ElementId helpers: canonical keys and the sibling tiebreak comparator.
 * The comparator is the heart of deterministic convergence — see logic.md §5.
 */
import { ElementId, ElementKey, Element } from './types';

/** Canonical map/set key for an id: `site#counter`. Stable and collision-free. */
export function keyOf(id: ElementId): ElementKey {
  return `${id.site}#${id.counter}`;
}

/**
 * Orders two SIBLINGS (elements sharing the same originId — i.e. concurrent inserts
 * after the same character). DESCENDING by (lamport, site): the larger sorts FIRST,
 * meaning closest to the shared origin (leftmost). logic.md §5.
 *
 * `(lamport, site)` is a strict total order across the whole system, so every replica
 * picks the same winner with zero coordination. The counter branch is a final totality
 * guard; it is effectively unreachable because a single site never reuses a lamport.
 */
export function compareSiblings(a: Element, b: Element): number {
  if (a.lamport !== b.lamport) return b.lamport - a.lamport; // larger lamport first
  if (a.id.site !== b.id.site) return a.id.site < b.id.site ? 1 : -1; // larger site first
  return b.id.counter - a.id.counter;
}
