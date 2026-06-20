# logic.md — The Sequence CRDT, Explained

> This file is a **learning deliverable**. Read it top to bottom and you should be
> able to re-implement the algorithm from scratch and explain _why_ concurrent edits
> merge without losing data. Code comments point back here; this is the source of truth.

---

## 0. The problem in one sentence

Many people type into the **same document at the same time**, on different machines,
with network delay between them. We need every machine to end up showing the **exact
same text**, no matter what order the edits arrive in, and **without throwing any
keystroke away**. That last part is why last-write-wins is banned: LWW resolves a
conflict by _deleting_ one side's work.

A **CRDT** (Conflict-free Replicated Data Type) solves this by designing the data
structure so that merging is automatic. The merge function is built into how operations
are defined, and it has three mathematical properties:

- **Commutative** — `apply(a); apply(b)` gives the same state as `apply(b); apply(a)`.
  Order of arrival does not matter.
- **Idempotent** — `apply(a); apply(a)` is the same as `apply(a)`. Receiving the same
  op twice (retries, reconnects, duplicate broadcasts) is harmless.
- **Associative** — grouping does not matter when merging batches.

If every operation has those properties, then any two replicas that have seen the
**same set** of operations are guaranteed to show identical content. We never need a
central authority to "decide the winner." This is the **convergence invariant**, and
the property-based tests in Phase 1 exist specifically to hammer on it.

---

## 1. Why a plain array does not work

The naive model is "a document is an array of characters, an insert is `splice(index, 0, ch)`."
This breaks the instant two people edit concurrently, because **a numeric index is not
stable**. Suppose the doc is `HAT`:

```
positions:  0 1 2
chars:      H A T
```

- Alice inserts `C` at index 0 → wants `CHAT`.
- Bob, concurrently, deletes index 0 (`H`) → wants `AT`.

Bob's "index 0" and Alice's "index 0" referred to the same `H` _at the time they acted_,
but once Alice's insert lands, every index shifts. Replaying Bob's "delete index 0" now
deletes `C`. The edits **interfere** because they are expressed relative to positions
that move. Indexes are not identities.

---

## 2. Identities: every character gets a unique ID

Each inserted character is one **element**. Its ID is:

```
ElementId = { site: string; counter: number }
```

- `site` — a unique ID for the replica (browser tab / server) that _created_ the element.
- `counter` — a per-site counter that increments on every element that site creates.

The pair `(site, counter)` is unique across the whole system **without coordination**:
two different sites can never collide because `site` differs; the same site never reuses
a `counter` because it only ever increments. This is a _Lamport-style_ unique id — no
central allocator needed. We render it as the string `site#counter` when we need a map key.

> Why not just a random UUID per char? We could, but `(site, counter)` is also our
> tiebreak input and is human-debuggable ("everything tab-A made, in order"). It doubles
> as causal bookkeeping.

---

## 3. The op format

There are exactly two operations. (Replace/rewrite from the AI panel in Phase 5 is just a
_delete range + insert run_ — a sequence of these two, never a special case.)

```
InsertOp = {
  type: 'insert',
  id:       ElementId,          // identity of the NEW character
  value:    string,             // exactly one character
  originId: ElementId | null,   // the id of the element this one was inserted AFTER
                                //   null  ==>  inserted at the very start of the doc
  lamport:  number              // Lamport timestamp at creation (used as tiebreak)
}

DeleteOp = {
  type: 'delete',
  id:   ElementId,              // identity of the character to tombstone
  lamport: number              // advances clocks; not needed for ordering
}
```

Notice what is **absent**: no array index appears anywhere. An insert says "I go right
after the element with _this id_." A delete says "tombstone the element with _this id_."
Both are phrased against immortal identities, so both mean the same thing on every
replica forever. That is the whole trick.

### Why insert references `originId` (the left neighbor)

When you type a character, you type it _between_ two existing characters. We record the
**left** one (`originId`). The new element is "a child of" its origin. At the start of the
document there is no left neighbor, so `originId = null` (conceptually, the child of a
virtual ROOT). We deliberately reference an _element id_, not "the left neighbor position,"
because the position can change but the id cannot.

---

## 4. Tombstones: delete never removes anything

A delete does **not** splice the character out. If it did, the element's id would vanish,
and a concurrent insert that referenced that id as its `originId` would be orphaned — it
would have nowhere to attach. So instead, delete marks the element as a **tombstone**: it
stays in the structure as an anchor point, but it is **invisible** in the rendered text.

We track tombstones as a set of ids:

```
deleted: Set<ElementId-as-string>
```

An element is **visible** iff it exists in the element map **and** its id is _not_ in
`deleted`. Modeling deletion as set-membership (rather than a mutable `deleted` flag on
the element object) buys us something important: a delete can be applied **before** its
matching insert ever arrives. The id just goes into the set; when the insert later lands,
the element is born already-tombstoned. No buffering, no "causal not ready" error. This is
what makes delete fully commutative with insert, not merely with other deletes.

Tombstones accumulate forever in this Phase-1 model. Garbage-collecting them safely (only
once _every_ replica has seen the delete) is a known hard problem; we note it and leave it
out of scope. See [architecture.md](architecture.md) for where GC would hook in later.

---

## 5. Total order: how the visible string is computed

State is a bag of elements plus a tombstone set. To render text we need a **deterministic
total order** over the elements that every replica computes identically. We use the
**RGA tree linearization**.

Think of the elements as a tree:

- The **root** is virtual. Its children are all elements with `originId === null`.
- Every other element is a **child of the element named by its `originId`**.
- **Siblings** (elements that share the same `originId` — i.e. concurrent inserts after the
  same character) are ordered among themselves by a fixed comparator (below).
- The visible sequence is a **pre-order depth-first traversal**: emit a node, then recurse
  into each of its children in sibling order.

```
render(node):
    for child in sortedChildren(node):     // root has no value of its own
        emit child.value (if visible)
        render(child)
```

### The sibling comparator (the tiebreak)

Two elements inserted after the **same** origin are _concurrent_ — neither knew about the
other. We must break the tie the **same way on every replica**, using only data carried in
the op. We sort siblings **descending** by:

```
(lamport, site)        // compare lamport first; if equal, compare site string
```

i.e. the sibling with the **larger** `(lamport, site)` is placed **first** (closest to the
shared origin, leftmost). Because `(lamport, site)` is globally unique and total, this
comparator is a strict total order — every replica picks the same winner for "who goes
left," with **zero communication**. Nobody's character is dropped; they just get a stable
relative order.

> Higher Lamport first means a _causally later_ concurrent insert sorts toward the origin.
> The exact direction is a free choice; what matters is that it is **consistent and total**.
> We pick `(lamport, site)` descending and never deviate.

### Worked example — concurrent inserts converge

Doc is `A` (one element, id `a`). Two sites, having both seen only `A`, type after it:

- Site `s1` inserts `B`: `originId = a`, `lamport = 2`.
- Site `s2` inserts `C`: `originId = a`, `lamport = 2`.

Both `B` and `C` are children of `a` (siblings). Lamports tie at 2, so compare site:
say `s2 > s1`, so `C` sorts first. Every replica, regardless of whether it received
`B` then `C` or `C` then `B`, computes children-of-`a` = `[C, B]` and renders:

```
A C B
```

No edit lost, identical on all replicas. **That is convergence.**

### Worked example — the `CHAT` / `AT` conflict from §1

Doc `HAT`: elements `h, a, t` with `h.originId=null, a.originId=h, t.originId=a`.

- Alice inserts `C` at the very start: `originId = null`, so `C` is a sibling of `h` under
  root. Tiebreak decides `C` vs `h`; say `C` sorts first → `C H A T`.
- Bob deletes `H`: `deleted = { h }`. `h` stays as a tombstone (anchor for `a`), invisible.

Merge both: elements `{C, h*, a, t}` with `h` tombstoned. Render root's children in order
`[C, h]`; `h` is invisible; then `a`, `t`. Result: **`C A T`** — Alice's insert kept,
Bob's delete kept, on every replica. Neither edit clobbered the other.

---

## 6. Lamport clocks

Each replica keeps a scalar `clock`:

- Before **creating** an op locally: `clock = clock + 1`; stamp the op with that value.
- On **receiving** any op: `clock = max(clock, op.lamport) + 1`.

This guarantees: if op X _causally precedes_ op Y (the author of Y had already seen X),
then `X.lamport < Y.lamport`. The Lamport value is what feeds the sibling tiebreak in §5,
and later (Phases 2–4) it lets a rejoining client advance its clock past everything it
catches up on. Lamport gives a _consistent_ order; combined with `site` it gives a _total_
one.

---

## 7. The convergence invariant (the thing the tests prove)

> **Invariant.** Any two replicas that have applied the **same set** of operations render
> **identical visible text**, regardless of the order in which those operations were applied
> or how many times each was applied.

Why it holds, tied to the three properties:

- **Idempotent.** Inserts are stored in a map keyed by id; re-inserting an existing id is a
  no-op. Deletes add an id to a set; re-adding is a no-op. So duplicates change nothing.
- **Commutative.** The rendered order is a _pure function of the element set + tombstone
  set_ (§5), computed fresh each render from origin pointers and the comparator. It never
  depends on insertion order into the map. And because deletes are set-membership, even an
  insert/delete pair commutes. So application order cannot change the result.
- **Associative** follows from commutativity over set union (merging batches = unioning the
  underlying sets).

Same set of ops ⇒ same element map ⇒ same tombstone set ⇒ same linearization ⇒ same text.
The Phase-1 property tests generate random op sets, apply them to multiple replicas in
**random orders and with random duplicates**, and assert the rendered strings are equal
every time. If the invariant ever breaks, those tests fail.

---

## 8. What this design deliberately does NOT do (yet)

- **No tombstone GC** — tombstones live forever (see §4).
- **No causal buffering needed** — because delete tolerates a missing target and render is
  recomputed from the full element set, ops can be applied in any order. (An insert whose
  `originId` element has not arrived yet simply links to a not-yet-present parent; it
  becomes visible once that parent exists. The map tolerates this; render skips dangling
  subtrees until their origin appears.)
- **No network, snapshots, or presence** — those are Phases 2–4 and do not change the CRDT
  core; they only transport these same ops around.
