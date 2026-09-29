import { z } from 'zod';

// ENV Schema
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  // No default: a missing DATABASE_URL is a misconfiguration, not something
  // to silently paper over (Section 51 — fail fast at boot).
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // 32+ chars so a trivially weak secret can't slip into any environment,
  // dev included — HS256's security is entirely the secret's entropy.
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  // Unlike DATABASE_URL, this gets a default rather than being required.
  // Redis is never the source of truth (Section 12) and rate limiting fails
  // open — the app must still boot and serve traffic with no Redis
  // available at all, so a missing REDIS_URL can't be a fail-fast condition
  // the way a missing DATABASE_URL is.
  //
  // Port 6380, not Redis's default 6379 (ADR-0028): on this dev machine,
  // WSL2's automatic localhost-forwarding exposes an unrelated project's
  // Redis at 127.0.0.1:6379, and Node's `localhost` resolution silently
  // preferred that loopback-specific bind over Docker's own wildcard one
  // for the same port. Matches docker-compose.yml's redis service, which
  // maps ITS 6380 host port to the container's normal internal 6379.
  REDIS_URL: z.string().min(1).default('redis://localhost:6380'),
  // Optional, same reasoning as REDIS_URL: password reset is a real feature
  // but not existential — auction browsing/bidding must still work with no
  // email provider configured. If unset, the app falls back to logging
  // reset emails instead of sending them (dev convenience), with a loud
  // warning at boot, not a silent gap.
  GMAIL_USER: z.string().email().optional(),
  GMAIL_APP_PASSWORD: z.string().min(1).optional(),
  // Used to build the reset-password link sent in the email. No frontend
  // exists yet (Section 73 — apps/web not started), so this defaults to
  // where it will run locally; the link is a placeholder contract until
  // that page exists, not a broken feature.
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),
  // Object storage (Section 27): s3mock locally, Cloudflare R2 in
  // production — both speak the same S3 API, so these defaults exactly
  // match docker-compose.yml's `s3mock` service (see its comment for the
  // two other options that were tried and abandoned first). Same reasoning
  // as REDIS_URL: the app must still boot (auction browsing/bidding must
  // still work) with no real object storage configured; only image upload
  // itself would fail.
  S3_ENDPOINT: z.string().url().default('http://localhost:9090'),
  // R2 has no real AWS regions — 'auto' is R2's own documented convention.
  // s3mock/AWS default to a real region name instead; this default is what
  // the local dev stack actually uses, overridden with 'auto' via a real
  // env var when deploying against R2.
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(1).default('auctionx-media'),
  S3_ACCESS_KEY_ID: z.string().min(1).default('auctionx'),
  S3_SECRET_ACCESS_KEY: z.string().min(1).default('auctionx_dev_password'),
  // The base URL a client can GET an uploaded object from directly — used
  // both to build the URL returned after a presigned upload, and to
  // validate that an auction's `images` array only ever references OUR
  // bucket, never an arbitrary external URL (modules/auctions/schema.ts).
  S3_PUBLIC_URL_BASE: z.string().url().default('http://localhost:9090/auctionx-media'),
  // Signs/verifies MockPaymentProvider's simulated webhook events (Section
  // 19/83 — no real payment provider account required for local dev). Gets
  // a default, unlike JWT_ACCESS_SECRET, because MockPaymentProvider itself
  // never runs in production (a real StripePaymentProvider would replace it
  // there, with Stripe's own signing secret) — this key only ever protects
  // traffic between this process and itself.
  MOCK_PAYMENT_WEBHOOK_SECRET: z.string().min(1).default('dev-mock-payment-webhook-secret'),
  // Redpanda locally (docker-compose.yml, ADR-0027) — Kafka-API-compatible,
  // so this is a real Kafka broker address either way. Same reasoning as
  // REDIS_URL/S3_ENDPOINT: the app must still boot and serve core traffic
  // with Kafka/Redpanda unreachable (Section 40) — only the Outbox
  // publisher and the notification consumer are affected, both of which
  // already retry indefinitely rather than crash the process.
  KAFKA_BROKERS: z.string().min(1).default('localhost:9092'),
  // Section 30: register/login/refresh are pre-authentication, so this is
  // keyed by IP alone (middleware/rateLimit.ts's authRateLimit) — every
  // account tested from the same dev machine shares one bucket. Defaults to
  // the real production-strict value; raise it in a local .env (never
  // .env.example) when doing heavy manual testing, then drop the override
  // when done so dev still exercises the real limit occasionally.
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  // Phase 9 (Section 25): search is a derived, eventually-consistent read
  // model, never the source of truth (Postgres stays that) — same
  // "must still boot with this unreachable" reasoning as REDIS_URL/
  // KAFKA_BROKERS, so this gets a default instead of being required.
  OPENSEARCH_URL: z.string().url().default('http://localhost:9200'),
  OPENSEARCH_AUCTIONS_INDEX: z.string().min(1).default('auctions'),
  // Phase 10 (Section 20/22, ADR-0032): self-hosted Ollama, chosen over a
  // paid cloud vision API specifically to keep local dev at $0 and
  // account-free (Section 83's "prefer free/local" principle applied to
  // AI the same way it was to object storage/search). Same "must still
  // boot with this unreachable" reasoning as OPENSEARCH_URL/KAFKA_BROKERS —
  // valuation is an enhancement (Section 24), never load-bearing for
  // auction creation itself.
  OLLAMA_URL: z.string().url().default('http://localhost:11434'),
  // A small (~1.6B), CPU-friendly vision-language model — chosen for
  // iteration speed on hardware with no GPU, at a real quality cost (see
  // ADR-0032): its outputs are a rough guess, not authoritative. A single
  // config value, swappable for a larger local model or a future cloud
  // provider without touching modules/ai's business logic. Named for what
  // it IS (a vision model), not for its first caller — renamed from
  // OLLAMA_VALUATION_MODEL (ADR-0032) once the listing assistant (ADR-0033)
  // became a second feature sharing the exact same model.
  OLLAMA_VISION_MODEL: z.string().min(1).default('moondream'),
  // CPU inference on a small local model is still seconds-to-tens-of-
  // seconds per call, not milliseconds — generous on purpose, this is a
  // background worker's timeout, never on any user-facing request path.
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
});

// Parse and Check Schema
function loadEnv() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error('Invalid environment configuration:');
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();
export type Env = typeof env;
