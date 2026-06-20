/**
 * Phase 4 tests: cross-instance fan-out. Two SEPARATE server instances share a MessageBus
 * (and a store); clients connected to different instances must converge and see each other's
 * presence. The InMemoryBus exercises the logic deterministically; a gated block runs the
 * exact same scenario over real Redis when REDIS_URL is set.
 */
import { startServer, ServerHandle } from './wsServer';
import { InMemoryStore } from './store';
import { InMemoryBroker, InMemoryBus, MessageBus } from './bus';
import { RedisBus } from './redisBus';
import { ClientConnection } from '../client/connection';
import { nodeWsTransport } from '../client/transport.node';
import { PresenceUser } from '../net/protocol';

jest.setTimeout(20_000);

const USER_A: PresenceUser = { userId: 'a', name: 'Ada', color: '#b45309' };
const USER_B: PresenceUser = { userId: 'b', name: 'Alan', color: '#1d4ed8' };

const live: ClientConnection[] = [];
const servers: ServerHandle[] = [];
const buses: MessageBus[] = [];

afterEach(async () => {
  for (const c of live) c.close();
  live.length = 0;
  for (const s of servers) await s.close();
  servers.length = 0;
  for (const bus of buses) await bus.close();
  buses.length = 0;
});

function connect(port: number, docId: string, user: PresenceUser): ClientConnection {
  const c = new ClientConnection(
    nodeWsTransport(`ws://localhost:${port}/?doc=${docId}`),
    docId,
    user,
    { flushIntervalMs: 10 },
  );
  live.push(c);
  return c;
}

function waitUntil(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
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

/** Run a full cross-instance scenario against two instances wired to the given buses. */
async function twoInstanceScenario(bus1: MessageBus, bus2: MessageBus): Promise<void> {
  const store = new InMemoryStore(); // shared store (single durable source of truth)
  const s1 = await startServer(0, { store, bus: bus1 });
  const s2 = await startServer(0, { store, bus: bus2 });
  servers.push(s1, s2);

  const a = connect(s1.port, 'doc', USER_A); // on instance 1
  const b = connect(s2.port, 'doc', USER_B); // on instance 2
  await Promise.all([synced(a), synced(b)]);

  // Concurrent edits on different instances converge.
  a.insertText(0, 'Hello');
  b.insertText(0, 'World');
  await waitUntil(() => a.text() === b.text() && a.text().length === 10);
  expect(a.text()).toBe(b.text());
  expect([...a.text()].sort().join('')).toBe([...'HelloWorld'].sort().join('')); // nothing lost/duped

  // A follow-up edit on instance 1 reaches instance 2.
  a.insertText(a.text().length, '!');
  await waitUntil(() => b.text() === a.text() && a.text().endsWith('!'));
  expect(b.text()).toBe(a.text());
  expect(a.text().length).toBe(11);

  // Presence crosses instances: B sees A's cursor, anchored to the right char.
  a.setCursor(a.caretAt(3));
  await waitUntil(() => b.remotePresence().some((p) => p.user.userId === 'a' && p.cursor !== null));
  const adaOnB = b.remotePresence().find((p) => p.user.userId === 'a')!;
  expect(adaOnB.user.color).toBe('#b45309');
  expect(b.caretIndex(adaOnB.cursor)).toBe(3);

  // Disconnect on instance 1 removes A from instance 2's presence.
  a.close();
  await waitUntil(() => b.remotePresence().every((p) => p.user.userId !== 'a'));
  expect(b.remotePresence().some((p) => p.user.userId === 'a')).toBe(false);
}

test('two instances over an in-memory bus stay in sync (ops + presence)', async () => {
  const broker = new InMemoryBroker();
  const bus1 = new InMemoryBus(broker);
  const bus2 = new InMemoryBus(broker);
  buses.push(bus1, bus2);
  await twoInstanceScenario(bus1, bus2);
});

test('a single instance still works with no bus configured', async () => {
  const s = await startServer(0, {});
  servers.push(s);
  const a = connect(s.port, 'solo', USER_A);
  const b = connect(s.port, 'solo', USER_B);
  await Promise.all([synced(a), synced(b)]);
  a.insertText(0, 'hi');
  await waitUntil(() => b.text() === 'hi');
  expect(b.text()).toBe('hi');
});

// Gated: only runs when a reachable Redis is provided. Proves the SAME scenario over real
// Redis pub/sub. Run with e.g. REDIS_URL=redis://localhost:6379 npm test.
const REDIS_URL = process.env.REDIS_URL;
const describeRedis = REDIS_URL ? describe : describe.skip;
describeRedis('RedisBus (real Redis)', () => {
  test('two instances over Redis pub/sub stay in sync', async () => {
    const bus1 = await RedisBus.connect(REDIS_URL!, 'instance-1');
    const bus2 = await RedisBus.connect(REDIS_URL!, 'instance-2');
    buses.push(bus1, bus2);
    await twoInstanceScenario(bus1, bus2);
  });
});
