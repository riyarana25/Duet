/**
 * The correctness guarantee (logic.md §7).
 *
 * Strategy: simulate several replicas making interleaved, partly-concurrent edits to
 * produce a realistic op log. Then assert the CONVERGENCE INVARIANT directly:
 *   any replica that has applied the same SET of ops renders identical text,
 *   regardless of apply order and regardless of duplicates.
 *
 * We test that by replaying the log in many random orders / with random duplicates and
 * asserting every result equals a single reference rendering.
 */
import fc from 'fast-check';
import { RGADocument } from './document';
import { Operation } from './types';

// ---- deterministic helpers (seeded so fast-check failures reproduce) ----

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

function withDuplicates(ops: readonly Operation[], rng: () => number): Operation[] {
  const out: Operation[] = [];
  for (const op of ops) {
    const n = 1 + Math.floor(rng() * 3); // 1..3 copies
    for (let i = 0; i < n; i++) out.push(op);
  }
  return out;
}

/** Apply a list of ops to a brand-new replica and return it. */
function replay(site: string, ops: readonly Operation[]): RGADocument {
  const d = new RGADocument(site);
  for (const op of ops) d.apply(op);
  return d;
}

// ---- the edit-scenario generator ----

const SITES = ['A', 'B', 'C'] as const;

type Cmd = { replica: number; kind: 'ins' | 'del' | 'sync'; pos: number; ch: string };

const cmdArb: fc.Arbitrary<Cmd> = fc.record({
  replica: fc.nat({ max: SITES.length - 1 }),
  // weight inserts so documents actually grow
  kind: fc.constantFrom<Cmd['kind']>('ins', 'ins', 'ins', 'del', 'sync'),
  pos: fc.nat({ max: 100000 }),
  ch: fc.constantFrom(...'abcde'.split('')),
});

/**
 * Interpret a command list against fresh replicas that only occasionally `sync`
 * (apply the whole shared log so far). The gaps between syncs are what create genuine
 * concurrency — inserts after the same origin from different sites. Returns the full op
 * log plus the live replicas.
 */
function runScenario(cmds: readonly Cmd[]): { log: Operation[]; replicas: RGADocument[] } {
  const replicas = SITES.map((s) => new RGADocument(s));
  const log: Operation[] = [];
  for (const c of cmds) {
    const r = replicas[c.replica % SITES.length]!;
    if (c.kind === 'sync') {
      for (const op of log) r.apply(op);
      continue;
    }
    const len = r.text().length;
    if (c.kind === 'ins') {
      log.push(r.generateInsert(c.pos % (len + 1), c.ch));
    } else if (len > 0) {
      log.push(r.generateDelete(c.pos % len));
    }
  }
  return { log, replicas };
}

// ---- the properties ----

describe('CRDT convergence (property-based)', () => {
  test('any apply order + duplicates -> identical visible text', () => {
    fc.assert(
      fc.property(
        fc.array(cmdArb, { maxLength: 80 }),
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        (cmds, seedA, seedB) => {
          const { log, replicas } = runScenario(cmds);

          // Reference rendering: a fresh replica, ops applied in authored order.
          const reference = replay('REF', log).text();

          // 1) A random permutation converges to the reference.
          const permA = shuffle(log, mulberry32(seedA));
          expect(replay('PA', permA).text()).toBe(reference);

          // 2) A random permutation WITH random duplicates also converges (idempotency).
          const rngB = mulberry32(seedB);
          const permB = shuffle(withDuplicates(log, rngB), rngB);
          expect(replay('PB', permB).text()).toBe(reference);

          // 3) The live author replicas, once each has seen the full log, all converge.
          for (const rep of replicas) for (const op of log) rep.apply(op);
          for (const rep of replicas) expect(rep.text()).toBe(reference);
        },
      ),
      { numRuns: 300 },
    );
  });

  test('idempotency: applying the entire log twice equals once', () => {
    fc.assert(
      fc.property(fc.array(cmdArb, { maxLength: 80 }), (cmds) => {
        const { log } = runScenario(cmds);
        const once = replay('X', log).text();
        const twice = replay('Y', [...log, ...log]).text();
        expect(twice).toBe(once);
      }),
      { numRuns: 200 },
    );
  });

  test('no edit is silently lost: every inserted-and-not-deleted char survives', () => {
    fc.assert(
      fc.property(fc.array(cmdArb, { maxLength: 80 }), (cmds) => {
        const { log } = runScenario(cmds);
        const finalText = replay('Z', log).text();

        // Count, per element key, inserts vs deletes in the log.
        const inserted = new Map<string, string>(); // key -> char
        const deleted = new Set<string>();
        for (const op of log) {
          const key = `${op.id.site}#${op.id.counter}`;
          if (op.type === 'insert') inserted.set(key, op.value);
          else deleted.add(key);
        }
        // Every inserted-but-never-deleted char must appear in the output, with the
        // correct multiplicity. (Convergence already pins the ORDER; this pins survival.)
        const expectedChars: Record<string, number> = {};
        for (const [key, ch] of inserted) {
          if (!deleted.has(key)) expectedChars[ch] = (expectedChars[ch] ?? 0) + 1;
        }
        const actualChars: Record<string, number> = {};
        for (const ch of finalText) actualChars[ch] = (actualChars[ch] ?? 0) + 1;
        expect(actualChars).toEqual(expectedChars);
      }),
      { numRuns: 200 },
    );
  });
});
