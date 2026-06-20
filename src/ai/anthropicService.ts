/**
 * AnthropicAIService — real LLM transforms via the Anthropic API (Phase 5).
 * Runs server-side only, so the API key never reaches the browser. Model + usage follow
 * the current API reference: claude-opus-4-8, non-streaming, max_tokens 16000.
 */
import Anthropic from '@anthropic-ai/sdk';
import { AIAction, AIService } from './aiService';

const SYSTEM: Record<AIAction, string> = {
  summarize:
    'Summarize the user-provided text concisely while preserving its meaning. ' +
    'Reply with ONLY the summary — no preamble, labels, or quotation marks.',
  improve:
    'Rewrite the user-provided text to improve clarity, flow, and concision without ' +
    'changing its meaning. Reply with ONLY the rewritten text — no preamble or commentary.',
};

export class AnthropicAIService implements AIService {
  private readonly client: Anthropic;

  /** `apiKey` is optional — the SDK reads ANTHROPIC_API_KEY from the env by default. */
  constructor(apiKey?: string) {
    this.client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  }

  async transform(action: AIAction, text: string): Promise<string> {
    const response = await this.client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 16000,
      system: SYSTEM[action],
      messages: [{ role: 'user', content: text }],
    });
    // Concatenate the text blocks. Typed structurally to stay robust across SDK versions.
    const blocks = response.content as Array<{ type: string; text?: string }>;
    return blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
      .trim();
  }
}
