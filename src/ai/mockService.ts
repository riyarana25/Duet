/** Deterministic AIService for tests — no network. */
import { AIAction, AIService } from './aiService';

export class MockAIService implements AIService {
  async transform(action: AIAction, text: string): Promise<string> {
    if (action === 'summarize') return 'SUMMARY';
    return text.toUpperCase(); // 'improve' → a visible, deterministic transform
  }
}
