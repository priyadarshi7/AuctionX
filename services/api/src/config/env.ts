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
  // 127.0.0.1, not localhost (ADR-0034) — a separate, later-discovered WSL2
  // issue: `localhost` can resolve to a STALE ::1 port-forward left over
  // from a container restart (vs. ADR-0028's collision with a live,
  // different service), which accepts the TCP connection then never
  // relays any protocol data.
  REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6380'),
  // Optional, same reasoning as REDIS_URL: password reset is a real feature
  // but not existential — auction browsing/bidding must still work with no
  // email provider configured. If unset, the app falls back to logging
  // reset emails instead of sending them (dev convenience), with a loud
  // warning at boot, not a silent gap.
  GMAIL_USER: z.string().email().optional(),
  GMAIL_APP_PASSWORD: z.string().min(1).optional(),
  // Resend (HTTP API, not SMTP) — ADR-0036 addendum: Render's free tier
  // blocks outbound SMTP ports (25/465/587) entirely, so GmailEmailSender's
  // raw-SMTP connection just hangs until timeout on Render, no matter how
  // correct the credentials are. Resend goes over normal HTTPS, which isn't
  // blocked. Preferred over Gmail when set (sender.ts's createEmailSender);
  // Gmail SMTP stays as a fallback for environments without this port
  // restriction (e.g. local dev). RESEND_FROM defaults to Resend's own
  // sandbox sender, which only delivers to the Resend account's own verified
  // email until a real sending domain is verified — a real limitation,
  // acceptable for now, worth revisiting before real users register.
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_FROM: z.string().min(1).default('AuctionX <onboarding@resend.dev>'),
  // Brevo (HTTP API) — ADR-0036 addendum: the one free option that delivers
  // to arbitrary real users WITHOUT owning a domain. Only requires
  // verifying a single email address (Brevo dashboard -> Senders -> Add a
  // sender -> confirm via the link Brevo emails to it) — no DNS access
  // needed, unlike Resend's domain requirement for anything beyond its own
  // sandbox. sender.ts's createEmailSender() prefers this over Resend for
  // exactly that reason. BREVO_FROM_EMAIL must be the address you verified.
  BREVO_API_KEY: z.string().min(1).optional(),
  BREVO_FROM_EMAIL: z.string().email().optional(),
  BREVO_FROM_NAME: z.string().min(1).default('AuctionX'),
  // Used to build the reset-password link sent in the email. No frontend
  // exists yet (Section 73 — apps/web not started), so this defaults to
  // where it will run locally; the link is a placeholder contract until
  // that page exists, not a broken feature.
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),
  // Pre-publication review (ADR-0041, modules/auctions/reviewPolicy.ts).
  // 'untrusted' is the real default: every listing is reviewed until an admin
  // marks a seller trusted. The test suite forces 'off' (tests/jest.env.ts)
  // so the many tests that publish auctions directly keep working.
  AUCTION_REVIEW_MODE: z.enum(['off', 'untrusted']).default('untrusted'),
  // Private bucket for seller documents (ADR-0041). MUST NOT be public:
  // downloads only ever happen through short-lived signed URLs.
  S3_DOCS_BUCKET: z.string().min(1).default('auctionx-docs'),
  // Uploaded-document scanning (ADR-0043). 'basic' = built-in content checks
  // only (works anywhere, no extra service). 'clamav' = also stream the file
  // to a clamd daemon and FAIL CLOSED if it cannot be reached. ClamAV needs
  // roughly 1GB of RAM, so it cannot run on Render's free tier; enable it
  // where a clamd is available (docker compose --profile scan up clamav).
  DOCUMENT_SCAN: z.enum(['basic', 'clamav']).default('basic'),
  CLAMAV_HOST: z.string().min(1).default('127.0.0.1'),
  CLAMAV_PORT: z.coerce.number().int().positive().default(3310),
  // Object storage (Section 27): s3mock locally, Cloudflare R2 in
  // production — both speak the same S3 API, so these defaults exactly
  // match docker-compose.yml's `s3mock` service (see its comment for the
  // two other options that were tried and abandoned first). Same reasoning
  // as REDIS_URL: the app must still boot (auction browsing/bidding must
  // still work) with no real object storage configured; only image upload
  // itself would fail.
  // 127.0.0.1, not localhost (ADR-0034): this URL is also handed straight
  // to the BROWSER as the presigned POST's form action
  // (infrastructure/storage/presign.ts) — if a WSL2 port-forward for
  // localhost:S3_PORT ever goes stale, every image upload fails with no
  // server-side error at all, since the presign call itself never touches
  // the network (it's pure signing); only the browser's own upload to the
  // returned URL fails.
  S3_ENDPOINT: z.string().url().default('http://127.0.0.1:9090'),
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
  // Also 127.0.0.1 (ADR-0034) — this is the base of every uploaded image's
  // actual <img src>, so a stale relay here means every photo on the site
  // breaks too, not just new uploads.
  S3_PUBLIC_URL_BASE: z.string().url().default('http://127.0.0.1:9090/auctionx-media'),
  // Signs/verifies MockPaymentProvider's simulated webhook events (Section
  // 19/83 — no real payment provider account required for local dev). Gets
  // a default, unlike JWT_ACCESS_SECRET, because MockPaymentProvider itself
  // never runs in production (a real StripePaymentProvider would replace it
  // there, with Stripe's own signing secret) — this key only ever protects
  // traffic between this process and itself.
  MOCK_PAYMENT_WEBHOOK_SECRET: z.string().min(1).default('dev-mock-payment-webhook-secret'),
  // Stripe Checkout (ADR-0044). TEST MODE ONLY: the refinement below refuses
  // to boot with a live key, so a real card can never be charged by this
  // deployment. Unset = the in-process mock provider (local dev and tests).
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  // The endpoint's signing secret (whsec_...), from the Stripe dashboard.
  // Optional on purpose: without it the webhook route rejects every event but
  // the buyer-triggered payment sync still settles payments.
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  STRIPE_CURRENCY: z.string().length(3).toLowerCase().default('usd'),
  // Redpanda locally (docker-compose.yml, ADR-0027) — Kafka-API-compatible,
  // so this is a real Kafka broker address either way. Same reasoning as
  // REDIS_URL/S3_ENDPOINT: the app must still boot and serve core traffic
  // with Kafka/Redpanda unreachable (Section 40) — only the Outbox
  // publisher and the notification consumer are affected, both of which
  // already retry indefinitely rather than crash the process.
  // 127.0.0.1, not localhost (ADR-0034).
  KAFKA_BROKERS: z.string().min(1).default('127.0.0.1:9092'),
  // SASL_SSL credentials for a managed broker (Aiven — ADR-0036). All three
  // optional and unset by default: local Redpanda runs with no auth at all,
  // so the Kafka client must still boot plaintext when these are absent.
  // When KAFKA_SASL_USERNAME is set, infrastructure/kafka/client.ts treats
  // that as the signal to also require the other two and switch the whole
  // connection to SASL_SSL.
  KAFKA_SASL_USERNAME: z.string().min(1).optional(),
  KAFKA_SASL_PASSWORD: z.string().min(1).optional(),
  // PEM content with real newlines replaced by literal "\n" — both a .env
  // file and Render/Fly's dashboard are single-line text fields, so this is
  // the standard way to carry a multi-line certificate through one env var.
  // client.ts un-escapes it back to real newlines before passing it to
  // kafkajs's ssl.ca. Aiven's SASL auth runs over TLS using a private
  // per-project CA, not a publicly trusted one — Node's default trust store
  // will reject the connection without this.
  KAFKA_SSL_CA: z.string().min(1).optional(),
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
  // 127.0.0.1, not localhost (ADR-0034).
  OPENSEARCH_URL: z.string().url().default('http://127.0.0.1:9200'),
  OPENSEARCH_AUCTIONS_INDEX: z.string().min(1).default('auctions'),
  // Phase 10 (Section 20/22, ADR-0032): self-hosted Ollama, chosen over a
  // paid cloud vision API specifically to keep local dev at $0 and
  // account-free (Section 83's "prefer free/local" principle applied to
  // AI the same way it was to object storage/search). Same "must still
  // boot with this unreachable" reasoning as OPENSEARCH_URL/KAFKA_BROKERS —
  // valuation is an enhancement (Section 24), never load-bearing for
  // auction creation itself.
  // 127.0.0.1, not localhost (ADR-0034).
  OLLAMA_URL: z.string().url().default('http://127.0.0.1:11434'),
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
}).superRefine((value, ctx) => {
  // Fail fast (Section 51) on a half-configured SASL setup rather than
  // booting and only discovering the gap when Kafka first tries to connect.
  if (value.KAFKA_SASL_USERNAME && (!value.KAFKA_SASL_PASSWORD || !value.KAFKA_SSL_CA)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'KAFKA_SASL_USERNAME is set but KAFKA_SASL_PASSWORD and/or KAFKA_SSL_CA is missing — ' +
        'all three are required together for SASL_SSL, or none of them for a local unauthenticated broker.',
      path: ['KAFKA_SASL_USERNAME'],
    });
  }
  // Hard stop on anything that is not a Stripe TEST key. Deliberately no
  // override flag: this project must never take real payments. The message
  // never echoes the key.
  if (value.STRIPE_SECRET_KEY && !/^(sk|rk)_test_/.test(value.STRIPE_SECRET_KEY)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'STRIPE_SECRET_KEY must be a Stripe TEST-mode key (sk_test_... or rk_test_...). ' +
        'Live keys are refused: this platform does not process real payments.',
      path: ['STRIPE_SECRET_KEY'],
    });
  }
  if (value.BREVO_API_KEY && !value.BREVO_FROM_EMAIL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'BREVO_API_KEY is set but BREVO_FROM_EMAIL is missing — both are required together.',
      path: ['BREVO_API_KEY'],
    });
  }
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
