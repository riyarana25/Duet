/**
 * ClientConnection — one editing session: an RGADocument replica + a Transport.
 *
 * Responsibilities:
 *  - Local edits generate CRDT ops, apply them locally, and buffer them for batched send.
 *  - Remote ops/presence arrive and are applied (apply() is idempotent + commutative, so
 *    out-of-order or duplicate delivery is harmless — logic.md §7).
 *  - Tracks the caret as a CRDT element id so it survives concurrent edits.
 *
 * Events: 'open', 'sync' (welcome received), 'change' (text changed), 'presence',
 * 'activity' (a peer authored ops; arg = their clientId), 'chat' (arg = ChatBroadcast),
 * 'close'.
 */
import { Emitter } from '../util/emitter';
import { newId } from '../util/id';
import { RGADocument } from '../crdt/document';
import { ElementId, Operation } from '../crdt/types';
import { ClientMessage, CursorPos, PresenceState, PresenceUser, PROTOCOL_VERSION, ServerMessage } from '../net/protocol';
import { AIAction } from '../ai/aiService';
import { Transport } from './transport';

export interface ClientOptions {
  /** How often buffered local ops are flushed to the server. */
  flushIntervalMs?: number;
}

export class ClientConnection extends Emitter {
  /** This client's CRDT replica. Read it for rendering. */
  readonly doc: RGADocument;
  /** CRDT site id — unique per connection, so two tabs of one user never collide. */
  readonly site: string;

  private readonly flushIntervalMs: number;
  private buffer: Operation[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private opened = false;
  private selfId: string | null = null;
  private presence = new Map<string, PresenceState>();
  /** In-flight AI requests, keyed by requestId, awaiting an 'ai-result'. */
  private readonly pendingAI = new Map<string, { resolve: (t: string) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly transport: Transport,
    readonly docId: string,
    readonly user: PresenceUser,
    opts: ClientOptions = {},
  ) {
    super();
    this.site = newId();
    this.doc = new RGADocument(this.site);
    this.flushIntervalMs = opts.flushIntervalMs ?? 50;

    transport.onOpen(() => this.handleOpen());
    transport.onMessage((d) => this.handleMessage(d));
    transport.onClose(() => {
      this.stopTimer();
      this.emit('close');
    });
  }

  // ---- status ----

  get isOpen(): boolean {
    return this.opened;
  }
  /** True once the server's welcome (catch-up) has been received. */
  get isSynced(): boolean {
    return this.selfId !== null;
  }
  get clientId(): string | null {
    return this.selfId;
  }

  // ---- local editing (buffered + batched) ----

  /** Insert a single character at visible `index`. */
  insert(index: number, ch: string): void {
    this.buffer.push(this.doc.generateInsert(index, ch));
    this.emit('change');
  }

  /** Insert a whole string at visible `index` (one op per character). */
  insertText(index: number, text: string): void {
    let at = index;
    for (const ch of text) {
      this.buffer.push(this.doc.generateInsert(at, ch));
      at += 1;
    }
    if (text.length > 0) this.emit('change');
  }

  /** Delete the visible character at `index`. */
  delete(index: number): void {
    this.buffer.push(this.doc.generateDelete(index));
    this.emit('change');
  }

  /** Delete `count` visible characters starting at `index` (left to right). */
  deleteRange(index: number, count: number): void {
    for (let i = 0; i < count; i++) this.buffer.push(this.doc.generateDelete(index));
    if (count > 0) this.emit('change');
  }

  text(): string {
    return this.doc.text();
  }

  /** Force-send buffered ops now (used by tests; normally the timer does this). */
  flush(): void {
    if (!this.opened || !this.transport.isOpen() || this.buffer.length === 0) return;
    const ops = this.buffer;
    this.buffer = [];
    this.send({ t: 'ops', ops });
  }

  // ---- cursors / presence ----

  /** Build a caret CursorPos for visible position `index` (anchored to the left char). */
  caretAt(index: number): CursorPos {
    const vis = this.doc.visibleElements();
    const anchor: ElementId | null = index <= 0 ? null : vis[index - 1]?.id ?? null;
    return { anchor, focus: anchor };
  }

  setCursor(cursor: CursorPos | null): void {
    if (this.opened && this.transport.isOpen()) this.send({ t: 'cursor', cursor });
  }

  /** Other participants' presence (excludes self). */
  remotePresence(): PresenceState[] {
    return [...this.presence.values()].filter((p) => p.clientId !== this.selfId);
  }

  /** Map a remote cursor's anchor id back to a caret index in THIS replica's view. */
  caretIndex(cursor: CursorPos | null): number {
    if (!cursor || cursor.focus === null) return 0;
    const vis = this.doc.visibleElements();
    const i = vis.findIndex((v) => v.id.site === cursor.focus!.site && v.id.counter === cursor.focus!.counter);
    return i < 0 ? 0 : i + 1; // caret sits just after the anchored char
  }

  // ---- AI assist (Phase 5) ----

  /**
   * Run an AI transform over the visible range [start, end) and replace it with the result
   * through the CRDT. The selection is captured as element ids up front, so the replacement
   * lands on the right characters even if concurrent edits shift positions while the LLM
   * runs. The replacement = tombstone each selected id + insert the result after the char
   * to the left of the selection (insert lamports beat the tombstoned ids, so the new text
   * renders exactly where the selection was — see logic.md §5).
   */
  async transformSelection(action: AIAction, start: number, end: number): Promise<void> {
    const vis = this.doc.visibleElements();
    if (start < 0 || end > vis.length || start >= end) {
      throw new RangeError(`selection [${start}, ${end}) out of range [0, ${vis.length})`);
    }
    const selected = vis.slice(start, end);
    const text = selected.map((v) => v.value).join('');
    const leftId: ElementId | null = start > 0 ? vis[start - 1]!.id : null;
    const selectedIds = selected.map((v) => v.id);

    const result = await this.requestAI(action, text);

    // Apply as CRDT ops (local + buffered for broadcast). Nothing here mutates text directly.
    for (const id of selectedIds) this.buffer.push(this.doc.deleteElement(id));
    let origin = leftId;
    for (const ch of result) {
      const op = this.doc.insertAfter(origin, ch);
      this.buffer.push(op);
      origin = op.id;
    }
    this.emit('change');
    this.flush();
  }

  /** Send a chat message to the room (server stamps identity + time, then echoes). */
  sendChat(text: string): void {
    const t = text.trim();
    if (t.length === 0 || !this.opened || !this.transport.isOpen()) return;
    this.send({ t: 'chat', text: t });
  }

  /** Send an AI request and resolve when its 'ai-result' arrives. */
  requestAI(action: AIAction, text: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (!this.opened || !this.transport.isOpen()) {
        reject(new Error('not connected'));
        return;
      }
      const requestId = newId();
      this.pendingAI.set(requestId, { resolve, reject });
      this.send({ t: 'ai', requestId, action, text });
    });
  }

  close(): void {
    this.stopTimer();
    this.transport.close();
  }

  // ---- internals ----

  private handleOpen(): void {
    this.opened = true;
    const join: ClientMessage = { t: 'join', v: PROTOCOL_VERSION, docId: this.docId, user: this.user };
    this.send(join);
    this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
    this.emit('open');
  }

  private handleMessage(data: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'welcome': {
        this.selfId = msg.selfId;
        // Catch up: load the snapshot (if any), then replay ops accepted since it.
        if (msg.snapshot) this.doc.load(msg.snapshot);
        for (const op of msg.ops) this.doc.apply(op);
        this.presence = new Map(msg.presence.map((p) => [p.clientId, p]));
        this.emit('sync');
        this.emit('change');
        this.emit('presence');
        break;
      }
      case 'ops': {
        for (const op of msg.ops) this.doc.apply(op);
        this.emit('change');
        this.emit('activity', msg.from); // who's actively editing (typing indicators)
        break;
      }
      case 'presence': {
        this.presence = new Map(msg.users.map((p) => [p.clientId, p]));
        this.emit('presence');
        break;
      }
      case 'chat': {
        this.emit('chat', msg);
        break;
      }
      case 'ai-result': {
        const pending = this.pendingAI.get(msg.requestId);
        if (!pending) break;
        this.pendingAI.delete(msg.requestId);
        if (msg.ok) pending.resolve(msg.text);
        else pending.reject(new Error(msg.error));
        break;
      }
    }
  }

  private send(msg: ClientMessage): void {
    this.transport.send(JSON.stringify(msg));
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
