/** Guard unit tests: rate limiting, identity sanitization, and frame validation. */
import { SlidingWindow, sanitizeUser, isValidOp, isValidClientMessage } from './guard';

describe('SlidingWindow', () => {
  test('allows up to the limit, then refuses', () => {
    const w = new SlidingWindow(5, 10_000);
    expect(w.allow(3)).toBe(true);
    expect(w.allow(2)).toBe(true);
    expect(w.allow(1)).toBe(false); // 6th unit in the window
  });

  test('recovers once the window has passed', async () => {
    const w = new SlidingWindow(2, 40);
    expect(w.allow(2)).toBe(true);
    expect(w.allow(1)).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(w.allow(2)).toBe(true);
  });
});

describe('sanitizeUser', () => {
  test('passes a normal identity through', () => {
    expect(sanitizeUser({ userId: 'u1', name: 'Ada', color: '#3b82f6' })).toEqual({
      userId: 'u1',
      name: 'Ada',
      color: '#3b82f6',
    });
  });

  test('clamps absurd names and fixes bad colours', () => {
    const u = sanitizeUser({ userId: 'u', name: 'x'.repeat(500), color: 'javascript:alert(1)' });
    expect(u!.name.length).toBeLessThanOrEqual(40);
    expect(u!.color).toBe('#d97706');
  });

  test('rejects wrong shapes', () => {
    expect(sanitizeUser(null)).toBeNull();
    expect(sanitizeUser({ name: 42 })).toBeNull();
  });
});

describe('op / frame validation', () => {
  const id = { site: 's1', counter: 0 };

  test('accepts a well-formed insert and delete', () => {
    expect(isValidOp({ type: 'insert', id, value: 'a', originId: null, lamport: 1 })).toBe(true);
    expect(isValidOp({ type: 'delete', id, lamport: 2 })).toBe(true);
  });

  test('rejects a multi-character insert (rate-limit smuggling)', () => {
    expect(isValidOp({ type: 'insert', id, value: 'not one char', originId: null, lamport: 1 })).toBe(false);
  });

  test('rejects malformed frames and unknown types', () => {
    expect(isValidClientMessage({ t: 'ops', ops: 'nope' })).toBe(false);
    expect(isValidClientMessage({ t: 'evil' })).toBe(false);
    expect(
      isValidClientMessage({ t: 'ops', ops: [{ type: 'insert', id, value: 'a', originId: null, lamport: 1 }] }),
    ).toBe(true);
  });
});
