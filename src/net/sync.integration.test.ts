/**
 * Phase 2 integration tests: real WebSocket server + multiple real client connections.
 * Proves the relay preserves CRDT convergence over the wire, that late joiners catch up,
 * and that presence (live cursors / who's online) works through the connection lifecycle.
 */
import { startServer, ServerHandle } from '../server/wsServer';
import { ClientConnection } from '../client/connection';
import { nodeWsTransport } from '../client/transport.node';
import { PresenceUser } from './protocol';

jest.setTimeout(15_000);

const USERS = {
  ada: { userId: 'ada', name: 'Ada', color: '#b45309' },
  alan: { userId: 'alan', name: 'Alan', color: '#1d4ed8' },
  grace: { userId: 'grace', name: 'Grace', color: '#15803d' },
} satisfies Record<string, PresenceUser>;

let server: ServerHandle;
let live: ClientConnection[] = [];

beforeEach(async () => {
  server = await startServer(0);
});

afterEach(async () => {
  for (const c of live) c.close();
  live = [];
  await server.close();
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

test('two clients converge on concurrent inserts (no edit lost)', async () => {
  const a = connect('doc1', USERS.ada);
  const b = connect('doc1', USERS.alan);
  await Promise.all([synced(a), synced(b)]);

  // Concurrent edits into the same (empty) document.
  a.insertText(0, 'Hello');
  b.insertText(0, 'World');

  await waitUntil(() => a.text() === b.text() && a.text().length === 10);

  expect(a.text()).toBe(b.text()); // converged
  expect([...a.text()].sort().join('')).toBe([...'HelloWorld'].sort().join('')); // nothing lost
});

test('three clients converge under interleaved edits', async () => {
  const a = connect('doc2', USERS.ada);
  const b = connect('doc2', USERS.alan);
  const c = connect('doc2', USERS.grace);
  await Promise.all([synced(a), synced(b), synced(c)]);

  a.insertText(0, 'aaa');
  b.insertText(0, 'bbb');
  c.insertText(0, 'ccc');
  await waitUntil(() => a.text() === b.text() && b.text() === c.text() && a.text().length === 9);

  // A follow-up edit from one client also propagates to all.
  a.insertText(a.text().length, '!');
  await waitUntil(() => a.text() === b.text() && b.text() === c.text() && a.text().endsWith('!'));

  expect(a.text()).toBe(b.text());
  expect(b.text()).toBe(c.text());
  expect(a.text().length).toBe(10);
});

test('a late joiner catches up via the welcome op log', async () => {
  const a = connect('doc3', USERS.ada);
  await synced(a);
  a.insertText(0, 'Document');
  await waitUntil(() => a.text() === 'Document');

  // Grace joins after the edits already happened.
  const grace = connect('doc3', USERS.grace);
  await synced(grace);
  await waitUntil(() => grace.text() === 'Document');

  // And new edits still flow both ways.
  grace.insertText(grace.text().length, '!');
  await waitUntil(() => a.text() === 'Document!');
  expect(a.text()).toBe('Document!');
});

test('presence: a remote cursor is visible to other clients, anchored to a char', async () => {
  const a = connect('doc4', USERS.ada);
  const b = connect('doc4', USERS.alan);
  await Promise.all([synced(a), synced(b)]);

  a.insertText(0, 'abcdef');
  await waitUntil(() => b.text() === 'abcdef');

  // Ada places her caret after the 3rd char.
  a.setCursor(a.caretAt(3));

  await waitUntil(() =>
    b.remotePresence().some((p) => p.user.userId === 'ada' && p.cursor !== null),
  );

  const ada = b.remotePresence().find((p) => p.user.userId === 'ada')!;
  expect(ada.user.color).toBe('#b45309');
  // b maps Ada's anchor id back to a caret index in its own identical view.
  expect(b.caretIndex(ada.cursor)).toBe(3);
});

test('disconnect removes a participant from presence', async () => {
  const a = connect('doc5', USERS.ada);
  const b = connect('doc5', USERS.alan);
  await Promise.all([synced(a), synced(b)]);

  await waitUntil(() => b.remotePresence().some((p) => p.user.userId === 'ada'));

  a.close();
  await waitUntil(() => b.remotePresence().every((p) => p.user.userId !== 'ada'));
  expect(b.remotePresence().some((p) => p.user.userId === 'ada')).toBe(false);
});

test('rooms are isolated by docId', async () => {
  const a = connect('roomA', USERS.ada);
  const b = connect('roomB', USERS.alan);
  await Promise.all([synced(a), synced(b)]);

  a.insertText(0, 'secret');
  await waitUntil(() => a.text() === 'secret');
  // Give any (incorrect) cross-room delivery a chance to happen, then assert it didn't.
  await new Promise((r) => setTimeout(r, 100));
  expect(b.text()).toBe('');
});
