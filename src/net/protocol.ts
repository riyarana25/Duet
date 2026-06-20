/**
 * Wire protocol for single-server real-time sync (Phase 2).
 *
 * All frames are JSON text. Ops travel as the EXACT Phase-1 Operation type — the server
 * is a dumb relay: it stores and forwards ops, never interprets or transforms them. There
 * is no server-side merge and no last-write-wins; convergence is the CRDT's job.
 *
 * Cursors are carried as element ids (anchor/focus), NOT numeric indexes, so a remote
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
 * caret sits immediately AFTER (null = document start). A plain caret has anchor === focus;
 * a selection has them differ (used by the AI panel in Phase 5).
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
  // AI assist (Phase 5): request a transform of the selected text. The RESULT is applied
  // client-side as CRDT ops — the server only runs the LLM, it never mutates the doc.
  | { t: 'ai'; requestId: string; action: AIAction; text: string };

export type ServerMessage =
  // Catch-up = persisted snapshot (or null) + ops since that snapshot. Phase 3.
  | { t: 'welcome'; selfId: string; snapshot: DocSnapshot | null; ops: Operation[]; presence: PresenceState[] }
  | { t: 'ops'; ops: Operation[]; from: string }
  | { t: 'presence'; users: PresenceState[] }
  | { t: 'ai-result'; requestId: string; ok: true; text: string }
  | { t: 'ai-result'; requestId: string; ok: false; error: string };

/** Stable dedup signature for an op (type + id). logic.md §7 — ops are idempotent. */
export function opSignature(op: Operation): string {
  return `${op.type === 'insert' ? 'i' : 'd'}:${op.id.site}#${op.id.counter}`;
}
