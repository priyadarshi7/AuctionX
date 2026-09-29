import { z } from 'zod';
import { env } from '../../config/env';
import { logger } from '../observability/logger';

// Thrown for any low-level failure talking to Ollama — unreachable, HTTP
// error, or a response that never becomes parseable/valid JSON even after
// the one bounded retry below. Each feature-specific provider
// (ollamaValuationProvider.ts, ollamaListingAssistantProvider.ts) catches
// this and re-throws its own typed error, keeping this file's contract
// generic rather than tied to any one feature's vocabulary.
export class OllamaCallError extends Error {}

const IMAGE_FETCH_TIMEOUT_MS = 15_000;

async function fetchOneImage(url: string, logEvent: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        logger.warn({ url, status: res.status }, `${logEvent}.image_fetch_failed`);
        return null;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      return buffer.toString('base64');
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    // A dead/unreachable image URL degrades to "this one image is
    // skipped," not a thrown error — the model still gets whatever other
    // images fetched successfully, plus the text fields either way.
    logger.warn({ err, url }, `${logEvent}.image_fetch_failed`);
    return null;
  }
}

// Shared by every Ollama-backed feature in modules/ai that hands the model
// real photos — base64 is the wire format Ollama's /api/generate expects
// for its `images` field. `urls` should already be capped by the caller
// (CPU inference cost scales with every image sent to a single shared
// container); this just fetches and encodes whatever it's given.
export async function fetchImagesAsBase64(urls: string[], logEvent: string): Promise<string[]> {
  const results = await Promise.all(urls.map((url) => fetchOneImage(url, logEvent)));
  return results.filter((img): img is string => img !== null);
}

type OllamaGenerateResponse = { response: string };

async function generate(prompt: string, images: string[]): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.OLLAMA_TIMEOUT_MS);
  try {
    const res = await fetch(`${env.OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: env.OLLAMA_VISION_MODEL,
        prompt,
        ...(images.length > 0 ? { images } : {}),
        format: 'json',
        stream: false,
      }),
    });
    if (!res.ok) {
      throw new OllamaCallError(`Ollama responded with HTTP ${res.status}`);
    }
    const body = (await res.json()) as OllamaGenerateResponse;
    return body.response;
  } catch (err) {
    if (err instanceof OllamaCallError) throw err;
    throw new OllamaCallError(`Ollama request failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function tryParse<T>(raw: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = schema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

// Call the model and expect JSON matching `schema`, with exactly ONE
// bounded retry (Section 41 — not an unbounded loop) on an unparseable or
// schema-invalid response: a stricter one-line reminder is appended and the
// whole prompt is sent again. Extracted here once a SECOND real feature
// (the listing assistant, ADR-0033) needed the identical shape ADR-0032's
// valuation provider already had — a small local model's most common
// failure mode isn't being unreachable, it's returning syntactically-close-
// but-wrong output, and this one retry recovers a real fraction of those
// without risking a retry storm.
export async function generateStructuredJson<T>(
  prompt: string,
  images: string[],
  schema: z.ZodType<T>,
  logEvent: string,
): Promise<T> {
  const first = await generate(prompt, images);
  const firstParsed = tryParse(first, schema);
  if (firstParsed) return firstParsed;

  logger.warn({ model: env.OLLAMA_VISION_MODEL }, `${logEvent}.unparseable_response_retrying`);
  const retryPrompt = `${prompt}\n\nYour previous response was not valid JSON. Respond with ONLY the JSON object, nothing else.`;
  const second = await generate(retryPrompt, images);
  const secondParsed = tryParse(second, schema);
  if (secondParsed) return secondParsed;

  throw new OllamaCallError('Model did not return a parseable response after one retry');
}
