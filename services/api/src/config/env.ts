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
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
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
