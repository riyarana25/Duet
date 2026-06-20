/**
 * Environment-neutral unique id. Uses the platform's crypto.randomUUID when available
 * (browsers, Node 19+); otherwise falls back to a v4-shaped id from Math.random — uniqueness
 * is statistically sufficient for site ids and request ids, which is all we mint here.
 */
export function newId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    return g.crypto.randomUUID();
  }
  let out = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += '-';
    } else if (i === 14) {
      out += '4';
    } else {
      const r = (Math.random() * 16) | 0;
      out += (i === 19 ? (r & 0x3) | 0x8 : r).toString(16);
    }
  }
  return out;
}
