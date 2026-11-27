import { isGroqConfigured } from './groqClient';
import { groqValuationProvider } from './groqValuationProvider';
import { ollamaValuationProvider } from './ollamaValuationProvider';
import type { ValuationProvider } from './valuationProvider';

// Groq when a key is configured (it works in production, where no local model
// can run); otherwise the self-hosted Ollama model (ADR-0032).
export function selectValuationProvider(): ValuationProvider {
  return isGroqConfigured() ? groqValuationProvider : ollamaValuationProvider;
}
