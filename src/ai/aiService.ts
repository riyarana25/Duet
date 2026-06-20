/**
 * AIService — the seam between the editor and an LLM (Phase 5). Kept tiny and injectable
 * so the server can run with a real Anthropic client in production or a deterministic mock
 * in tests. The result of a transform is applied to the document THROUGH THE CRDT (as
 * delete + insert ops), never as a direct buffer mutation.
 */
export type AIAction = 'summarize' | 'improve';

export interface AIService {
  /** Transform `text` per `action` and return the replacement text. */
  transform(action: AIAction, text: string): Promise<string>;
}
