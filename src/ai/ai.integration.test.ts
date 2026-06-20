/**
 * Phase 5 tests: AI assist applied THROUGH THE CRDT.
 * The key assertion is that an AI transform on one client lands as CRDT ops that converge
 * on a second client — i.e. the result is real collaborative state, not a local mutation.
 */
import { startServer, ServerHandle } from '../server/wsServer';
import { ClientConnection } from '../client/connection';
import { nodeWsTransport } from '../client/transport.node';
import { PresenceUser } from '../net/protocol';
import { MockAIService } from './mockService';
import { AnthropicAIService } from './anthropicService';

jest.setTimeout(15_000);

const USER_A: PresenceUser = { userId: 'a', name: 'A', color: '#b45309' };
const USER_B: PresenceUser = { userId: 'b', name: 'B', color: '#1d4ed8' };

let server: ServerHandle;
let live: ClientConnection[] = [];

afterEach(async () => {
  for (const c of live) c.close();
  live = [];
  if (server) await server.close();
});

function connect(docId: string, user: PresenceUser): ClientConnection {
  const c = new ClientConnection(
    nodeWsTransport(`ws://localhost:${server.port}/?doc=${docId}`),
    docId,
    user,
    { flushIntervalMs: 10 },
  );
  live.push(c);
  return c;
}

function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitUntil timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}
const synced = (c: ClientConnection): Promise<void> => waitUntil(() => c.isSynced);

test('improve replaces the selection, and the result converges on a peer (ops, not mutation)', async () => {
  server = await startServer(0, { ai: new MockAIService() });
  const a = connect('doc', USER_A);
  const b = connect('doc', USER_B);
  await Promise.all([synced(a), synced(b)]);

  a.insertText(0, 'hello world');
  await waitUntil(() => b.text() === 'hello world');

  // Improve the first word "hello" → MockAIService uppercases it.
  await a.transformSelection('improve', 0, 5);

  await waitUntil(() => a.text() === 'HELLO world' && b.text() === 'HELLO world');
  expect(a.text()).toBe('HELLO world');
  expect(b.text()).toBe('HELLO world'); // proves it went through the CRDT to the peer
});

test('summarize replaces the selection with the model output', async () => {
  server = await startServer(0, { ai: new MockAIService() });
  const a = connect('doc2', USER_A);
  const b = connect('doc2', USER_B);
  await Promise.all([synced(a), synced(b)]);

  a.insertText(0, 'abc');
  await waitUntil(() => b.text() === 'abc');

  await a.transformSelection('summarize', 0, 3); // MockAIService → 'SUMMARY'
  await waitUntil(() => a.text() === 'SUMMARY' && b.text() === 'SUMMARY');
  expect(b.text()).toBe('SUMMARY');
});

test('a mid-selection replacement keeps surrounding text intact', async () => {
  server = await startServer(0, { ai: new MockAIService() });
  const a = connect('doc3', USER_A);
  await synced(a);

  a.insertText(0, 'one two three');
  await waitUntil(() => a.text() === 'one two three');

  // Replace "two" (indices 4..7) → "TWO".
  await a.transformSelection('improve', 4, 7);
  await waitUntil(() => a.text() === 'one TWO three');
  expect(a.text()).toBe('one TWO three');
});

test('AI request is rejected when no AI service is configured', async () => {
  server = await startServer(0, {}); // no ai
  const a = connect('doc4', USER_A);
  await synced(a);
  a.insertText(0, 'x');

  await expect(a.requestAI('summarize', 'x')).rejects.toThrow(/not configured/i);
});

// Gated: real Anthropic call. Runs only with ANTHROPIC_API_KEY set.
const API_KEY = process.env.ANTHROPIC_API_KEY;
const describeReal = API_KEY ? describe : describe.skip;
describeReal('AnthropicAIService (real API)', () => {
  test('summarize returns non-empty text', async () => {
    const ai = new AnthropicAIService();
    const out = await ai.transform(
      'summarize',
      'The cat sat on the mat. The cat was content. The mat was warm and soft.',
    );
    expect(out.trim().length).toBeGreaterThan(0);
  }, 60_000);
});
