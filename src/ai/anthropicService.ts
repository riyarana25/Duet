/**
 * AnthropicAIService — real LLM transforms via the Anthropic API.
 * Runs server-side only, so the API key never reaches the browser. Model + usage follow
 * the current API reference: claude-opus-4-8, non-streaming, max_tokens 16000.
 */
import Anthropic from '@anthropic-ai/sdk';
import { AIAction, AIService } from './aiService';

// Wire actions keep their original names; the editor surfaces them as Explain/Refactor.
const SYSTEM: Record<AIAction, string> = {
  summarize:
    'You annotate code for a collaborative code editor. Reply with a concise explanation ' +
    'of what the provided code does, formatted as line comments (each line starting with ' +
    '"// "), followed by the original content verbatim and unchanged. If the input is prose ' +
    'rather than code, reply with only a concise summary instead. No preamble, no code fences.',
  improve:
    'You refactor code for a collaborative code editor. Rewrite the provided code to improve ' +
    'clarity, naming, and structure WITHOUT changing its behavior. If the input is prose ' +
    'rather than code, improve its clarity and concision instead. Reply with ONLY the ' +
    'rewritten content — no preamble, no commentary, no code fences.',
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
