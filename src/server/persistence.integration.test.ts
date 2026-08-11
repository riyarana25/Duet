/**
 * Persistence tests: snapshots + op log, and rejoin/restart catch-up.
 * Proves (a) snapshots are taken on the interval, (b) a late joiner reconstructs from
 * snapshot + ops-since, and (c) state survives a full server restart (FileStore).
 *
 * Note: a client's text() reflects LOCAL state immediately, so it is NOT a signal that the
 * server received the ops. We therefore poll the store (server-side durable state) directly.
 */
import { mkdtemp, rm } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { startServer } from './wsServer';
import { DocStore, InMemoryStore, LoadedDoc } from './store';
import { FileStore } from './fileStore';
import { RGADocument } from '../crdt/document';
import { ClientConnection } from '../client/connection';
import { nodeWsTransport } from '../client/transport.node';
import { PresenceUser } from '../net/protocol';

jest.setTimeout(15_000);

const USER_A: PresenceUser = { userId: 'a', name: 'A', color: '#b45309' };
const USER_B: PresenceUser = { userId: 'b', name: 'B', color: '#1d4ed8' };

const live: ClientConnection[] = [];
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

afterEach(() => {
  for (const c of live) c.close();
  live.length = 0;
});

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

/** Reconstruct the document text from a persisted snapshot + ops (the rejoin path). */
function materialize(loaded: LoadedDoc): string {
  const d = loaded.snapshot ? RGADocument.fromSnapshot('x', loaded.snapshot) : new RGADocument('x');
  for (const op of loaded.ops) d.apply(op);
  return d.text();
}

/** Poll the store until its persisted state satisfies `pred` (server-side signal). */
async function waitForStore(
  store: DocStore,
  docId: string,
  pred: (l: LoadedDoc) => boolean,
  timeoutMs = 5000,
): Promise<LoadedDoc> {
  const start = Date.now();
  for (;;) {
    const loaded = await store.loadDocument(docId);
    if (pred(loaded)) return loaded;
    if (Date.now() - start > timeoutMs) throw new Error('waitForStore timed out');
    await delay(20);
  }
}

test('a snapshot is taken on the interval and a late joiner reconstructs from it', async () => {
  const store = new InMemoryStore();
  const server = await startServer(0, { store, snapshotEveryOps: 5 });
  try {
    const a = connect(server.port, 'snapdoc', USER_A);
    await synced(a);
    a.insertText(0, 'abcdefghij'); // 10 inserts -> snapshots at 5 and 10
    a.flush();

    // Wait for the SERVER to have snapshotted all 10 chars.
    const loaded = await waitForStore(
      store,
      'snapdoc',
      (l) => l.snapshot !== null && l.snapshot.elements.length === 10,
    );
    expect(materialize(loaded)).toBe('abcdefghij');

    const b = connect(server.port, 'snapdoc', USER_B);
    await synced(b);
    await waitUntil(() => b.text() === 'abcdefghij');
    expect(b.text()).toBe('abcdefghij');
  } finally {
    await server.close();
  }
});

test('rejoin uses snapshot + ops-since-snapshot (both paths)', async () => {
  const store = new InMemoryStore();
  const server = await startServer(0, { store, snapshotEveryOps: 5 });
  try {
    const a = connect(server.port, 'splitdoc', USER_A);
    await synced(a);

    a.insertText(0, 'abcde'); // exactly 5 -> snapshot, recent buffer cleared
    a.flush();
    await waitForStore(
      store,
      'splitdoc',
      (l) => l.snapshot !== null && l.snapshot.elements.length === 5 && l.ops.length === 0,
    );

    a.insertText(5, 'fg'); // 2 more -> below interval, stay as ops-since-snapshot
    a.flush();
    const loaded = await waitForStore(store, 'splitdoc', (l) => l.ops.length === 2);

    expect(loaded.snapshot!.elements.length).toBe(5); // snapshot covers 'abcde'
    expect(loaded.ops.length).toBe(2); // 'f','g' live in the op log
    expect(materialize(loaded)).toBe('abcdefg'); // snapshot + ops together

    // A late joiner must combine BOTH to converge.
    const b = connect(server.port, 'splitdoc', USER_B);
    await synced(b);
    await waitUntil(() => b.text() === 'abcdefg');
    expect(b.text()).toBe('abcdefg');
  } finally {
    await server.close();
  }
});

test('state survives a full server restart (FileStore durability)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'editor-persist-'));
  try {
    // First server: write content, wait until it is durably on disk, then shut down.
    const store1 = new FileStore(dir);
    const s1 = await startServer(0, { store: store1, snapshotEveryOps: 3 });
    const a = connect(s1.port, 'persdoc', USER_A);
    await synced(a);
    a.insertText(0, 'persisted');
    a.flush();
    await waitForStore(store1, 'persdoc', (l) => materialize(l) === 'persisted');
    await s1.close();

    // Brand-new server instance, same data dir: content must be restored.
    const s2 = await startServer(0, { store: new FileStore(dir), snapshotEveryOps: 3 });
    try {
      const b = connect(s2.port, 'persdoc', USER_B);
      await synced(b);
      await waitUntil(() => b.text() === 'persisted');
      expect(b.text()).toBe('persisted');

      // And editing continues correctly on top of restored state.
      b.insertText(b.text().length, '!');
      await waitUntil(() => b.text() === 'persisted!');
      expect(b.text()).toBe('persisted!');
    } finally {
      await s2.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
