import { z } from 'zod';
import { env } from '../../config/env';
import { fetchImagesAsBase64, generateStructuredJson, OllamaCallError } from './ollamaClient';
import {
  ValuationProviderError,
  type ValuationInput,
  type ValuationProvider,
  type ValuationResult,
} from './valuationProvider';

// Capped, not "however many the seller uploaded" — CPU inference cost on a
// self-hosted model scales with every image sent, and Section 46's general
// "don't assume infinite capacity" reasoning applies just as much to a
// single shared Ollama container as it does to a database. Three is enough
// for the model to form an opinion without turning one valuation into a
// multi-minute CPU job.
const MAX_IMAGES = 3;

const LOG_EVENT = 'ai.valuation';

// The model reasons in whole US dollars, not cents — asking a small local
// model to correctly produce integer cents directly is asking it to also
// get a x100 unit conversion right, which is exactly the kind of easy-to-
// fumble arithmetic small models are worst at. Converting USD -> cents
// ourselves, in code, is reliable; trusting the model's own cents math
// would not be.
// explanation deliberately allows an empty string — confirmed live against
// a real moondream response: it reliably returns syntactically valid JSON
// matching every OTHER field, but sometimes leaves explanation as "" rather
// than omitting or malforming it. Rejecting that as "unparseable" would
// throw away an otherwise perfectly usable numeric result over a small
// model's known weakness at open-ended text generation specifically — see
// toResult's fallback below for what a blank explanation becomes.
const rawValuationSchema = z.object({
  estimatedValueUsd: z.number().nonnegative(),
  priceRangeLowUsd: z.number().nonnegative(),
  priceRangeHighUsd: z.number().nonnegative(),
  confidence: z.number().min(0).max(1),
  explanation: z.string(),
});

function buildPrompt(input: ValuationInput, imageCount: number): string {
  const imageNote =
    imageCount > 0
      ? `${imageCount} photo(s) of the item are attached.`
      : 'No photos were provided — value based on the text description alone, and reflect that with a lower confidence.';

  return `You are appraising an item for an online auction. ${imageNote}

Title: ${input.title}
Category: ${input.category}
Condition: ${input.condition}
Description: ${input.description}

Respond with ONLY a JSON object (no other text) in exactly this shape:
{"estimatedValueUsd": number, "priceRangeLowUsd": number, "priceRangeHighUsd": number, "confidence": number between 0 and 1, "explanation": "one or two sentences"}`;
}

// Exported purely so tests/ai/ollamaValuationProvider.test.ts can exercise
// the clamping invariant below directly, without a real Ollama call — same
// reasoning as middleware/rateLimit.ts exporting bidRateLimitKeyBy.
export function toCents(usd: number): number {
  return Math.round(usd * 100);
}

// A small local model isn't reliably internally consistent — nothing
// guarantees priceRangeLow <= estimatedValue <= priceRangeHigh on its own.
// Rather than treating that as a hard validation failure (which would fail
// a real, otherwise-usable response just for this), the range is widened in
// code to always include the point estimate — a cheap invariant to enforce
// ourselves rather than trust the model to have gotten right.
export function toResult(raw: z.infer<typeof rawValuationSchema>, model: string): ValuationResult {
  const estimatedValueCents = toCents(raw.estimatedValueUsd);
  const low = Math.min(toCents(raw.priceRangeLowUsd), estimatedValueCents);
  const high = Math.max(toCents(raw.priceRangeHighUsd), estimatedValueCents);
  return {
    estimatedValueCents,
    priceRangeLowCents: low,
    priceRangeHighCents: high,
    confidence: raw.confidence,
    // Confirmed live: moondream sometimes returns "" rather than skipping
    // the field or leaving it out — a blank string stored as-is would
    // render as a silently empty area in a future UI with no indication
    // why. A plain, honest fallback beats a mysterious gap.
    explanation: raw.explanation.trim().length > 0 ? raw.explanation : 'No explanation was provided by the model.',
    model,
  };
}

// Section 20's AI valuation, backed by a self-hosted Ollama model (ADR-0032
// — chosen for the "prefer free/local" deployment target over a paid cloud
// vision API). The actual model call/retry/parse logic lives in
// ollamaClient.ts, shared with modules/ai's other Ollama-backed feature —
// this class only owns the valuation-specific prompt, schema, and USD-to-
// cents/range-clamping conversion.
export class OllamaValuationProvider implements ValuationProvider {
  readonly name = 'ollama';

  async valuate(input: ValuationInput): Promise<ValuationResult> {
    const imageUrls = input.imageUrls.slice(0, MAX_IMAGES);
    const images = await fetchImagesAsBase64(imageUrls, LOG_EVENT);
    const prompt = buildPrompt(input, images.length);

    try {
      const raw = await generateStructuredJson(prompt, images, rawValuationSchema, LOG_EVENT);
      return toResult(raw, env.OLLAMA_VISION_MODEL);
    } catch (err) {
      if (err instanceof OllamaCallError) {
        throw new ValuationProviderError(err.message);
      }
      throw err;
    }
  }
}

export const ollamaValuationProvider = new OllamaValuationProvider();
