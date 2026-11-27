import type { z } from 'zod';
import { env } from '../../config/env';
import { logger } from '../observability/logger';

// Every way a Groq call can fail, with a message that is safe to show a
// seller. The provider's response body is logged, never forwarded: it can
// mention account details, and Section 32 keeps internals out of responses.
export type GroqFailure = 'not_configured' | 'rate_limited' | 'rejected' | 'unavailable' | 'bad_output';

const MESSAGES: Record<GroqFailure, string> = {
  not_configured: 'AI features are not set up on this server.',
  rate_limited: 'The AI service is busy right now. Try again in a minute.',
  rejected: 'The AI service rejected the request.',
  unavailable: 'The AI service could not be reached.',
  bad_output: 'The AI did not return a usable answer. Try again.',
};

export class GroqError extends Error {
  constructor(public readonly reason: GroqFailure) {
    super(MESSAGES[reason]);
    this.name = 'GroqError';
  }
}

export function isGroqConfigured(): boolean {
  return Boolean(env.GROQ_API_KEY);
}

// Base64 inflates bytes by a third; 3 MB of image stays near 4 MB on the wire.
const MAX_INLINE_IMAGE_BYTES = 3 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 10_000;

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/;

// Groq can download a public HTTPS image itself (production storage). A local
// address (s3mock in development) is unreachable from Groq, so those bytes are
// sent inline. An image that cannot be read is skipped, not fatal.
export async function toImageUrl(url: string): Promise<string | null> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && !PRIVATE_HOST.test(parsed.hostname)) return url;

    const res = await fetch(url, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_INLINE_IMAGE_BYTES) {
      logger.warn({ url, bytes: bytes.length }, 'ai.groq.image_too_large_to_inline');
      return null;
    }
    const type = res.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
    return `data:${type};base64,${bytes.toString('base64')}`;
  } catch (err) {
    logger.warn({ err, url }, 'ai.groq.image_skipped');
    return null;
  }
}

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

async function complete(system: string, content: ContentPart[], logEvent: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${env.GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.GROQ_API_KEY}` },
      // Section 67: never wait forever on another service.
      signal: AbortSignal.timeout(env.GROQ_TIMEOUT_MS),
      body: JSON.stringify({
        model: env.GROQ_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_completion_tokens: 1500,
        // Qwen models "think" by default; for form-filling that only costs
        // latency and tokens. Other model families reject these values.
        ...(env.GROQ_MODEL.startsWith('qwen/') ? { reasoning_effort: 'none', reasoning_format: 'hidden' } : {}),
      }),
    });
  } catch (err) {
    logger.warn({ err }, `${logEvent}.unreachable`);
    throw new GroqError('unavailable');
  }

  if (!res.ok) {
    // Anything shaped like a key is masked before it can reach the logs.
    const detail = (await res.text().catch(() => '')).slice(0, 500).replace(/gsk_[A-Za-z0-9_-]+/g, '[redacted]');
    logger.warn({ status: res.status, detail, model: env.GROQ_MODEL }, `${logEvent}.http_error`);
    // No automatic retry on 429: the quota is shared, and retrying at once
    // only spends more of it (Section 41).
    if (res.status === 429) throw new GroqError('rate_limited');
    throw new GroqError(res.status >= 500 ? 'unavailable' : 'rejected');
  }

  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return body.choices?.[0]?.message?.content ?? '';
}

function tryParse<T>(raw: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T | null {
  try {
    const result = schema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

// Ask for JSON matching `schema`, with exactly one retry if the answer does
// not parse. Model output is untrusted input like any other (Section 28).
export async function groqJson<T>(args: {
  system: string;
  prompt: string;
  imageUrls: string[];
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  logEvent: string;
}): Promise<T> {
  if (!isGroqConfigured()) throw new GroqError('not_configured');

  const images = (await Promise.all(args.imageUrls.slice(0, env.GROQ_MAX_IMAGES).map(toImageUrl))).filter(
    (url): url is string => url !== null,
  );
  const content: ContentPart[] = [
    { type: 'text', text: args.prompt },
    ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
  ];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const parsed = tryParse(await complete(args.system, content, args.logEvent), args.schema);
    if (parsed !== null) return parsed;
    logger.warn({ attempt, model: env.GROQ_MODEL }, `${args.logEvent}.unparseable_response`);
  }
  throw new GroqError('bad_output');
}
