/**
 * RedisBus — a MessageBus backed by real Redis pub/sub, for true horizontal scaling across
 * processes/machines. Uses two connections because a client in subscriber mode cannot also
 * issue publish commands (Redis rule). Channels are per-doc: `editor:doc:<docId>`.
 *
 * Tests using this are gated on REDIS_URL being set + reachable (see the integration test);
 * the InMemoryBus covers the same logic deterministically without a dependency.
 */
import { createClient } from 'redis';
import { BusEnvelope, BusHandler, MessageBus } from './bus';

type RedisClient = ReturnType<typeof createClient>;

export class RedisBus implements MessageBus {
  readonly instanceId: string;
  private readonly handlers = new Map<string, BusHandler>();

  private constructor(
    instanceId: string,
    private readonly pub: RedisClient,
    private readonly sub: RedisClient,
  ) {
    this.instanceId = instanceId;
  }

  static async connect(url: string, instanceId: string): Promise<RedisBus> {
    const pub = createClient({ url });
    const sub = pub.duplicate();
    await pub.connect();
    await sub.connect();
    return new RedisBus(instanceId, pub, sub);
  }

  private channel(docId: string): string {
    return `editor:doc:${docId}`;
  }

  async publish(docId: string, env: BusEnvelope): Promise<void> {
    await this.pub.publish(this.channel(docId), JSON.stringify(env));
  }

  async subscribe(docId: string, handler: BusHandler): Promise<void> {
    this.handlers.set(docId, handler);
    await this.sub.subscribe(this.channel(docId), (message: string) => {
      try {
        handler(JSON.parse(message) as BusEnvelope);
      } catch {
        /* ignore malformed */
      }
    });
  }

  async unsubscribe(docId: string): Promise<void> {
    await this.sub.unsubscribe(this.channel(docId));
    this.handlers.delete(docId);
  }

  async close(): Promise<void> {
    await this.sub.quit();
    await this.pub.quit();
  }
}
