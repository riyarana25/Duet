/**
 * Wire protocol for real-time sync between client and server.
 *
 * All frames are JSON text. Ops travel as the exact CRDT Operation type — the server
 * is a dumb relay: it stores and forwards ops, never interprets or transforms them. There
 * is no server-side merge and no last-write-wins; convergence is the CRDT's job.
 *
 * Cursors are carried as element ids (anchor/focus), not numeric indexes, so a remote
 * caret stays anchored to the correct character as concurrent edits shift text. logic.md.
 */
import { DocSnapshot, ElementId, Operation } from '../crdt/types';
import { AIAction } from '../ai/aiService';

export const PROTOCOL_VERSION = 1;

/** Identity shown to other users (display only — distinct from the CRDT site id). */
export interface PresenceUser {
  readonly userId: string;
  readonly name: string;
  /** Per-user cursor color (hex), assigned by the client. */
  readonly color: string;
}

/**
 * A cursor/selection expressed in CRDT terms. `anchor`/`focus` are the element ids the
 * caret sits immediately after (null = document start). A plain caret has anchor === focus;
 * a selection has them differ.
 */
export interface CursorPos {
  readonly anchor: ElementId | null;
  readonly focus: ElementId | null;
}

/** One participant's live presence, as tracked by the server. */
export interface PresenceState {
  readonly clientId: string;
  readonly user: PresenceUser;
  readonly cursor: CursorPos | null;
}

export type ClientMessage =
  | { t: 'join'; v: number; docId: string; user: PresenceUser }
  | { t: 'ops'; ops: Operation[] }
  | { t: 'cursor'; cursor: CursorPos | null }
  // AI assist: request a transform of the selected text. The RESULT is applied
  // client-side as CRDT ops — the server only runs the LLM, it never mutates the doc.
  | { t: 'ai'; requestId: string; action: AIAction; text: string }
  // Room chat: ephemeral (not persisted); the server stamps sender identity + time.
  | { t: 'chat'; text: string };

/** One chat message as broadcast to a room (identity stamped server-side). */
export interface ChatBroadcast {
  t: 'chat';
  from: string;
  name: string;
  color: string;
  text: string;
  ts: number;
}

export type ServerMessage =
  // Catch-up = persisted snapshot (or null) + ops since that snapshot.
  | { t: 'welcome'; selfId: string; snapshot: DocSnapshot | null; ops: Operation[]; presence: PresenceState[] }
  | { t: 'ops'; ops: Operation[]; from: string }
  | { t: 'presence'; users: PresenceState[] }
  | { t: 'ai-result'; requestId: string; ok: true; text: string }
  | { t: 'ai-result'; requestId: string; ok: false; error: string }
  | ChatBroadcast;

/** Stable dedup signature for an op (type + id). logic.md §7 — ops are idempotent. */
export function opSignature(op: Operation): string {
  return `${op.type === 'insert' ? 'i' : 'd'}:${op.id.site}#${op.id.counter}`;
}
