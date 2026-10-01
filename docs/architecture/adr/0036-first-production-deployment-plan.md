# 0036 — First production deployment: provider choices, what's skipped, and the Dockerfile

## Context

Raised directly: "lets deploy it... tell me whatever upstash redis key,
postgres string... plan it." Everything built so far (Phase 0-10, see
PROGRESS.md) has only ever run against local Docker Compose infra. Going
live means: picking real providers for each piece (Section 83 already
names the targets), writing a production Dockerfile (didn't exist until
this task), and deciding what to do about the three pieces of local infra
that don't have generous managed free tiers (Kafka, OpenSearch, Ollama).

Explicitly agreed with the developer before any of this was written:
deploy the current feature set now, build Admin panel + real Stripe
integration as the next milestone on top of a live deployment, rather
than blocking the first deploy on those. Stripe itself will use test/
sandbox mode — no Connect/payout/business-verification scope needed yet.

## Decision

**Provider mapping** (Section 83's targets, now concrete):

```text
Frontend (apps/web)        -> Vercel
Backend API (services/api) -> Render or Fly.io (verify current free-tier
                               limits at signup time — they change)
PostgreSQL                 -> Neon or Supabase
Redis                      -> Upstash Redis
Object storage              -> Cloudflare R2
Kafka                      -> Upstash Kafka (see "Why" below — NOT skipped)
OpenSearch                 -> skipped for v1 (search returns 503
                               SEARCH_UNAVAILABLE, everything else works)
Ollama                     -> skipped for v1 (valuation stays
                               PENDING/FAILED, never blocks auction
                               creation — Section 24)
```

**Kafka is the one exception to "skip what has no free managed tier"**:
since ADR-0027, `Notification` rows are created ONLY by
`modules/notifications/consumer.ts` — a Kafka consumer, not a synchronous
write anymore. No Kafka in production means outbid/won/sold/payment
notifications never fire at all, not a graceful degradation the way
search/valuation are. Upstash's Kafka product (same account as the Redis
one) closes this without self-hosting anything.

**New `services/api/Dockerfile`**: multi-stage build. The build context is
the REPO ROOT, not `services/api` — this is an npm workspaces monorepo
(one root `package.json`/`package-lock.json` covers every workspace), so
the lockfile has to be present to install correctly.
`npm ci -w services/api` scopes the install to this workspace's own
dependency tree (confirmed live: `apps/web`'s much heavier Next.js/React
deps never land in this image) while still resolving against the single
shared lockfile. Migrations are deliberately NOT run as part of the
image's own boot (`CMD`) — see "Why" below.

## Why

**A real, non-obvious lesson from actually building and running the
image, not just writing it**: npm workspaces hoists nearly everything to
the top-level `/app/node_modules` — `services/api/node_modules` doesn't
exist at all after `npm ci -w services/api` (confirmed by inspecting the
built image directly). The Dockerfile's runtime stage has to preserve the
SAME `/app` root + `services/api` subfolder layout as the build stage,
copying `/app/node_modules` (not `/app/services/api/node_modules`, which
doesn't exist), because Node's module resolution walks up parent
directories looking for `node_modules` — flattening the structure into
just `/app/services/api` would break every import.

**Migrations as a separate release step, not baked into `CMD`**: a
platform that scales the web process to N instances, or restarts it on
every deploy, would otherwise race N copies of `prisma migrate deploy`
against each other on boot. Render/Fly both support a distinct "release
command" / "pre-deploy command" that runs once before the new version
receives traffic — that's where `npx prisma migrate deploy` belongs, not
in `server.ts`'s own startup path.

**A fresh `JWT_ACCESS_SECRET` is mandatory, not a suggestion**: the one in
the local `.env` has been visible in this development session's history;
reusing it in production would mean a secret with uncertain exposure
signing every access token on a live deployment. Generate a new one the
same way the local one originally was:
`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.

**Found and fixed in the process of actually testing the image, not
assumed**: `npm run build` (the real production build, not just
`tsc --noEmit`) was hard-failing the whole time on a pre-existing type
error in `ollamaValuationProvider.ts` — every earlier `tsc --noEmit`
check this session passed clean, which is a DIFFERENT compiler invocation
than the one `npm run build` actually uses for a release artifact, so the
discrepancy went unnoticed until an actual Docker build was attempted.
Root cause: `ollamaClient.ts`'s `generateStructuredJson`/`tryParse`
declared their `schema` parameter as `z.ZodType<T>` — which defaults
`Input` to `T` — but `rawValuationSchema` is a `z.preprocess(...)`, whose
real `Input` is `unknown` (it accepts anything before transforming it).
Fixed by declaring the parameter as `z.ZodType<T, z.ZodTypeDef, unknown>`
instead, which is the actually-correct type for any schema validating
untrusted external JSON — removed the awkward explicit
`z.ZodType<RawValuation>` annotation this unblocks, letting `rawValuationSchema`'s
type infer naturally again.

**Verified live, not just "it builds"**: ran the built image with
standard port publishing against the real local Postgres/Redis/s3mock (via
`host.docker.internal`) — `/readiness` returned 200, a login attempt
correctly returned 401, confirming the containerized app actually serves
real traffic, not just that `docker build` exits 0.

## A real local-dev-only limitation found and deliberately NOT fixed

Running the containerized API against the LOCAL `docker-compose.yml`
Redpanda failed its Kafka connection entirely — traced to
`redpanda`'s `--advertise-kafka-addr=PLAINTEXT://localhost:9092`: Kafka
clients reconnect to whatever address the broker advertises after the
initial handshake, and `localhost` only resolves correctly for a client
in the exact same network namespace as the broker. The API has always run
natively (`npm run dev`) until this task, so this was never hit before —
it's the first time anything has tried to reach the local Redpanda from
inside a container.

**Deliberately not fixed**: there's no single advertised address that
works for both a host-native process (today's actual local dev setup) and
a containerized one at the same time without a proper multi-listener Kafka
config (more complexity than currently justified). It also doesn't affect
production at all, since the deployment target is managed Upstash Kafka,
not self-hosted Redpanda. Noted here so it isn't mistaken for a Dockerfile
bug if someone tries `docker compose up` with the API containerized
locally in the future.

## Tradeoffs

```text
+ Zero schema/architecture changes needed for this phase — every piece of
  local infra (Redis, Kafka/Outbox, S3-compatible storage) was already
  built against a generic client/endpoint, exactly so this swap would be
  config-only (Section 83's own stated principle, now actually exercised).
+ OpenSearch/Ollama skipped for v1 costs nothing broken — both were
  deliberately designed to degrade gracefully from day one (ADR-0029/
  ADR-0032), not retrofitted for this deployment.
- Kafka being load-bearing for notifications (not just "nice to have"
  infra) is a direct consequence of ADR-0027's own design — worth knowing
  if a future "what can we cut" pass ever reconsiders it.
- Gmail SMTP's ~500/day send cap (ADR-0006/ADR-0033) is now a REAL
  constraint the moment this has actual traffic, not a theoretical one —
  not addressed by this deployment, flagged again here since it's more
  relevant now than when first noted.
- The Redpanda advertised-listener limitation above means local Docker-
  based end-to-end testing of the API container against local Kafka isn't
  possible without further config — only matters if that specific testing
  need comes up later.
```

## Consequences

- New `services/api/Dockerfile`, new root `.dockerignore`.
- `infrastructure/ai/ollamaClient.ts` and `ollamaValuationProvider.ts`
  changed (the real build-blocking type fix above) — 17/17 AI tests still
  passing, lint clean, confirmed via an actual `npm run build` + `tsc
  --noEmit`, not just one or the other.
- Nothing in `docker-compose.yml` changed — local dev continues exactly
  as before (native `npm run dev`, not containerized).

## Revisit Conditions

- If local Docker-based end-to-end testing against Redpanda is ever
  actually needed, revisit the advertised-listener config then (e.g. a
  second listener advertised for a Docker-internal hostname).
- If Gmail's send cap becomes a real problem post-launch, swap
  `GmailEmailSender` for a dedicated provider — `sender.ts`'s own doc
  comment already names this as the intended extension point.
- Once Admin panel + real Stripe land (the agreed next milestone), this
  ADR's provider list doesn't need to change — both are backend/frontend
  features deploying onto the exact same infra already planned here.
