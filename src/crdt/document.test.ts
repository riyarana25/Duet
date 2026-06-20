/**
 * Deterministic, human-readable CRDT tests. These mirror the worked examples in
 * logic.md so the spec and the code provably agree. The exhaustive convergence proof
 * lives in convergence.property.test.ts.
 */
import { RGADocument } from './document';
import { InsertOp } from './types';

describe('RGADocument — basic local editing', () => {
  test('sequential typing builds the expected string', () => {
    const d = new RGADocument('s1');
    'hello'.split('').forEach((ch, i) => d.generateInsert(i, ch));
    expect(d.text()).toBe('hello');
  });

  test('insert in the middle', () => {
    const d = new RGADocument('s1');
    'hd'.split('').forEach((ch, i) => d.generateInsert(i, ch));
    d.generateInsert(1, 'i'); // "h|d" -> "hid"
    expect(d.text()).toBe('hid');
  });

  test('delete tombstones a character (stays an anchor, invisible)', () => {
    const d = new RGADocument('s1');
    'cat'.split('').forEach((ch, i) => d.generateInsert(i, ch));
    d.generateDelete(1); // remove 'a'
    expect(d.text()).toBe('ct');
  });

  test('out-of-range insert/delete throw', () => {
    const d = new RGADocument('s1');
    expect(() => d.generateInsert(1, 'x')).toThrow(RangeError);
    expect(() => d.generateDelete(0)).toThrow(RangeError);
    expect(() => d.generateInsert(0, 'ab')).toThrow(); // not a single char
  });
});

describe('RGADocument — convergence on the worked examples (logic.md §5)', () => {
  test('two replicas converge regardless of delivery order ("A C B")', () => {
    const s1 = new RGADocument('s1');
    const s2 = new RGADocument('s2');

    const opA = s1.generateInsert(0, 'A'); // s1 authors "A"
    s2.apply(opA); // both now show "A"

    // Concurrent inserts after 'A' (neither replica has seen the other's op):
    const opB = s1.generateInsert(1, 'B');
    const opC = s2.generateInsert(1, 'C');

    // Deliver crosswise, opposite orders on each side:
    s1.apply(opC);
    s2.apply(opB);

    expect(s1.text()).toBe(s2.text()); // converged
    // opC has the higher Lamport (s2 advanced its clock applying opA), so 'C' sorts first.
    expect(s1.text()).toBe('ACB');
  });

  test('pure (lamport, site) tiebreak: equal lamport -> larger site sorts first', () => {
    // Hand-crafted ops with EQUAL lamport to isolate the site tiebreak.
    const anchor: InsertOp = {
      type: 'insert',
      id: { site: 's0', counter: 0 },
      value: 'A',
      originId: null,
      lamport: 1,
    };
    const fromLo: InsertOp = {
      type: 'insert',
      id: { site: 'aaa', counter: 0 },
      value: 'L',
      originId: anchor.id,
      lamport: 5,
    };
    const fromHi: InsertOp = {
      type: 'insert',
      id: { site: 'zzz', counter: 0 },
      value: 'H',
      originId: anchor.id,
      lamport: 5, // tie with fromLo -> decided by site; 'zzz' > 'aaa' so 'H' first
    };

    const d1 = new RGADocument('x');
    const d2 = new RGADocument('y');
    [anchor, fromLo, fromHi].forEach((op) => d1.apply(op));
    [anchor, fromHi, fromLo].forEach((op) => d2.apply(op)); // different order

    expect(d1.text()).toBe('AHL');
    expect(d2.text()).toBe('AHL'); // same despite reversed delivery
  });

  test('the CHAT/AT conflict: insert + concurrent delete both survive (logic.md §5)', () => {
    const alice = new RGADocument('alice');
    const bob = new RGADocument('bob');

    // Both start synced on "HAT" (alice authors, bob receives).
    const hatOps = 'HAT'.split('').map((ch, i) => alice.generateInsert(i, ch));
    hatOps.forEach((op) => bob.apply(op));
    expect(bob.text()).toBe('HAT');

    // Concurrent: alice inserts 'C' at start; bob deletes 'H'.
    const opC = alice.generateInsert(0, 'C');
    const opDelH = bob.generateDelete(0);

    // Merge both ways:
    alice.apply(opDelH);
    bob.apply(opC);

    expect(alice.text()).toBe(bob.text());
    expect(alice.text()).toBe('CAT'); // Alice's insert kept, Bob's delete kept
  });
});

describe('RGADocument — idempotency', () => {
  test('applying an op twice equals applying it once', () => {
    const d1 = new RGADocument('a');
    const op = d1.generateInsert(0, 'X');

    const d2 = new RGADocument('b');
    d2.apply(op);
    d2.apply(op); // duplicate delivery
    d2.apply(op);

    expect(d2.text()).toBe('X');
  });

  test('duplicate deletes are harmless', () => {
    const d = new RGADocument('a');
    d.generateInsert(0, 'X');
    const del = d.generateDelete(0);
    d.apply(del);
    d.apply(del);
    expect(d.text()).toBe('');
  });

  test('a delete that arrives BEFORE its insert still converges', () => {
    const author = new RGADocument('a');
    const ins = author.generateInsert(0, 'X');
    const del = author.generateDelete(0);

    const replica = new RGADocument('b');
    replica.apply(del); // tombstone first...
    replica.apply(ins); // ...then the insert: element is born already-deleted
    expect(replica.text()).toBe('');
  });
});
