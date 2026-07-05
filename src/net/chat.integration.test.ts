/** Room chat: relayed to all participants with server-stamped identity. */
import { startServer, ServerHandle } from '../server/wsServer';
import { ClientConnection } from '../client/connection';
import { nodeWsTransport } from '../client/transport.node';
import { ChatBroadcast, PresenceUser } from './protocol';

jest.setTimeout(15_000);

const USER_A: PresenceUser = { userId: 'a', name: 'Ada', color: '#d97706' };
const USER_B: PresenceUser = { userId: 'b', name: 'Alan', color: '#3b82f6' };

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

test('a chat message reaches every participant with the sender identity stamped', async () => {
  server = await startServer(0, {});
  const a = connect('chatty', USER_A);
  const b = connect('chatty', USER_B);
  await Promise.all([synced(a), synced(b)]);

  const gotB: ChatBroadcast[] = [];
  const gotA: ChatBroadcast[] = [];
  b.on('chat', (...args: unknown[]) => gotB.push(args[0] as ChatBroadcast));
  a.on('chat', (...args: unknown[]) => gotA.push(args[0] as ChatBroadcast));

  a.sendChat('hello room');
  await waitUntil(() => gotB.length === 1 && gotA.length === 1);

  expect(gotB[0]!.text).toBe('hello room');
  expect(gotB[0]!.name).toBe('Ada'); // stamped by the server, not the sender payload
  expect(gotB[0]!.from).toBe(a.clientId);
  expect(gotA[0]!.text).toBe('hello room'); // sender gets the same echo
});

test('empty and whitespace-only chat messages are not sent', async () => {
  server = await startServer(0, {});
  const a = connect('chatty2', USER_A);
  const b = connect('chatty2', USER_B);
  await Promise.all([synced(a), synced(b)]);

  const got: ChatBroadcast[] = [];
  b.on('chat', (...args: unknown[]) => got.push(args[0] as ChatBroadcast));

  a.sendChat('   ');
  a.sendChat('');
  a.sendChat('real');
  await waitUntil(() => got.length === 1);
  expect(got[0]!.text).toBe('real');
});
