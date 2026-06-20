/**
 * FileStore — a DocStore backed by the filesystem, to demonstrate durability across a
 * server restart. Per document:
 *   <dataDir>/<slug>.snapshot.json   latest snapshot (atomic write via tmp + rename)
 *   <dataDir>/<slug>.oplog.jsonl     append-only ops since that snapshot (one JSON/line)
 *
 * This is intentionally simple (not a production DB). It shows the snapshot+oplog shape;
 * a real deployment would use a transactional store. See store.ts for the interval tradeoff.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { DocSnapshot, Operation } from '../crdt/types';
import { DocStore, LoadedDoc } from './store';

export class FileStore implements DocStore {
  constructor(private readonly dataDir: string) {}

  private slug(docId: string): string {
    return encodeURIComponent(docId).replace(/[^a-zA-Z0-9_.-]/g, '_');
  }
  private snapPath(docId: string): string {
    return path.join(this.dataDir, `${this.slug(docId)}.snapshot.json`);
  }
  private logPath(docId: string): string {
    return path.join(this.dataDir, `${this.slug(docId)}.oplog.jsonl`);
  }

  async loadDocument(docId: string): Promise<LoadedDoc> {
    await fs.mkdir(this.dataDir, { recursive: true });

    let snapshot: DocSnapshot | null = null;
    try {
      snapshot = JSON.parse(await fs.readFile(this.snapPath(docId), 'utf8')) as DocSnapshot;
    } catch {
      snapshot = null; // no snapshot yet
    }

    let ops: Operation[] = [];
    try {
      const raw = await fs.readFile(this.logPath(docId), 'utf8');
      ops = raw
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Operation);
    } catch {
      ops = []; // no op log yet
    }

    return { snapshot, ops };
  }

  async appendOps(docId: string, ops: Operation[]): Promise<void> {
    if (ops.length === 0) return;
    await fs.mkdir(this.dataDir, { recursive: true });
    const lines = ops.map((op) => JSON.stringify(op)).join('\n') + '\n';
    await fs.appendFile(this.logPath(docId), lines, 'utf8');
  }

  async saveSnapshot(docId: string, snapshot: DocSnapshot): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    const tmp = this.snapPath(docId) + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(snapshot), 'utf8');
    await fs.rename(tmp, this.snapPath(docId)); // atomic replace
    // The new snapshot subsumes everything logged so far: truncate the op log.
    await fs.writeFile(this.logPath(docId), '', 'utf8');
  }
}
