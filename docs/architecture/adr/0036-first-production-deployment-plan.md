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
Object storage              -> Supabase Storage (see "Why" below — went
                               through R2 and Backblaze B2 first, both
                               ruled out by the same no-card constraint)
Kafka                      -> Aiven for Apache Kafka (see "Why" below —
                               NOT skipped; went through two providers
                               before this one, see history below)
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
search/valuation are.

**Kafka went through three providers before landing on one that's
actually free, not two**:

1. Upstash Kafka — the original plan. Deprecated; caught directly by the
   developer before any wiring was attempted.
2. Redpanda Cloud Serverless — picked next specifically because it's the
   SAME technology already running locally (`redpandadata/redpanda` in
   `docker-compose.yml`), so local and production would've stayed on
   identical Kafka-API-compatible tech, not just "both speak Kafka."
   Caught directly, again, before any wiring: it's only a 14-day ($100
   credit) or 30-day-via-marketplace ($300 credit) trial — a real card is
   required to keep using it afterward. Not actually free, despite how
   "free to start" reads in its own marketing.
3. **Aiven for Apache Kafka — the one that's actually, indefinitely free,
   no card.** Confirmed directly (not assumed, given the previous two
   misses): 250 KiB/s throughput, 3-day retention, up to 5 topics, no
   trial period, no card requirement to create or keep using it.

**The 5-topic cap matters here, checked against this app's real usage**:
this codebase publishes to exactly 5 source topics (`auction-events`,
`bid-events`, `payment-events`, `search-events`, `ai-valuation-events`)
— right at Aiven's free-tier cap, with zero room for the per-topic
`-dlq` topics `infrastructure/kafka/consumer.ts` can also create on a
handler failure. Judged an acceptable risk, not a blocker: that same
file already treats a failed DLQ-topic publish as non-fatal (logged
only — "the original message was already durably on its source topic...
nothing is lost, only the DLQ copy didn't get made this time"). Hitting
the cap just means losing that convenience copy on whichever topic
fails first, not an outage or data loss — a degradation the code was
already designed to tolerate, not a new failure mode introduced by this
choice. Confluent Cloud ($400 credit + $0-while-idle) remains a noted
fallback if Aiven's terms or this topic-count math ever changes.

**Object storage went through three rounds of real-numbers checking, not
one assumption — and landed somewhere smaller-but-actually-usable rather
than bigger-but-blocked**:

1. First concern raised (directly: "Cloudfare R2 may charge extra for
   Class A operations, we are avoiding that"): checked R2's actual free
   tier rather than assuming — 10GB storage + 1M Class A (write) ops/
   month + 10M Class B (read) ops/month + ALWAYS-free egress, no cap.
   That margin is roughly 32,000 uploads/day before R2 costs anything.
   Checked the alternative raised by the concern (Supabase Storage,
   since Postgres already lives there — one fewer vendor) too: only 1GB
   storage + 5GB/month egress SHARED across the entire Supabase project
   (Postgres + Auth + Storage draw from the same pool) — at that point,
   a bigger practical risk for an image-heavy read pattern (every
   browse-page view re-fetches auction photos) than R2's write-side
   pricing. Conclusion at that point: stay on R2.
2. **Then a real, separate blocker surfaced**: R2 genuinely requires a
   credit card on file to activate, even for free-tier-only usage — not
   available here. Checked two no-card alternatives: Cloudinary (no
   card, confirmed) and Backblaze B2 (no card, confirmed). Cloudinary
   was already considered and rejected once before, during the original
   MEDIA-001 task (ADR-0022) — it isn't S3-compatible, so adopting it
   now would mean writing an entirely separate upload code path and
   reversing that earlier decision's whole reasoning (local dev's
   s3mock and production staying on the same generic S3 client code).
   Backblaze B2 is ALSO S3-compatible — a pure config swap. Decision at
   that point: Backblaze B2.
3. **A second, equally real blocker surfaced on B2 specifically**:
   confirmed directly against Backblaze's own documentation — making a
   bucket PUBLIC (required, since this app serves images via a
   permanent direct URL, not signed/expiring GET requests) needs either
   an existing payment history or a one-time ~$1 verification charge.
   Same root constraint as R2: a card, somewhere. Re-checked Supabase
   Storage with this specific question in mind (not re-litigating the
   egress-size tradeoff from round 1, which still applies) — confirmed
   it's officially S3-compatible (GA status, not a workaround) and found
   no evidence of any payment gate on public buckets. **Final decision:
   Supabase Storage**, accepting the smaller 1GB/5GB-shared-egress
   allowance from round 1 as the real cost of the hard no-card
   constraint overriding the "biggest free tier" optimization.

**A real gap found while filling in real credentials, not assumed**:
`infrastructure/kafka/client.ts` only ever configured `clientId`/
`brokers` — no `sasl`/`ssl` options at all, since it was only ever built
against a plaintext local broker. This means wiring up ANY managed Kafka
provider (Aiven, Redpanda Cloud, Confluent, or anything else) needs a
real, small code change (SASL_SSL auth) before it will actually connect
— not just a config value paste like Postgres/Redis/Supabase Storage
are. Deferred
until real Aiven credentials exist to verify the auth wiring against,
same "verify live, don't assume" discipline as the rest of this
deployment.

**Postgres (Supabase) took two real, separate fixes before migrations
actually applied — both found live, neither assumed**:

1. Supabase's "direct connection" host (`db.<ref>.supabase.co:5432`,
   the one shown by default) had NO public DNS record at all for this
   project — confirmed independently via Node, `curl`, AND an external
   DNS-over-HTTPS lookup against Cloudflare's resolver, specifically to
   rule out a local network problem before concluding it was real
   (`google.com` resolved instantly throughout). Fixed by switching to
   Supabase's POOLER connection string instead (Project Settings ->
   Database -> Connection Pooling) — a different host entirely
   (`aws-0-<region>.pooler.supabase.com`) and a different username
   format (`postgres.<project-ref>`, not just `postgres`).
2. The pooler's TRANSACTION-mode port (6543, Supabase's own default
   tab) connects fine for ordinary queries but `npx prisma migrate
   deploy` failed outright with `P1017` ("server has closed the
   connection"): Prisma Migrate depends on session-level Postgres
   features (advisory locks, to prevent two concurrent migration runs)
   that PgBouncer's transaction-pooling mode doesn't support. Fixed by
   using the SAME pooler host's SESSION-mode port (5432) instead of
   transaction-mode (6543). Since this app runs as one persistent
   long-lived process (Render/Fly), not a serverless function needing
   thousands of parallel pooled connections, session mode was kept for
   BOTH migrations and normal runtime traffic — one connection string,
   not two to maintain.

Verified past "it connects": `npx prisma migrate deploy` applied all 13
existing migrations clean against the real database, and a real model
query (`prisma.user.count()`) confirmed all 11 application tables exist
and are queryable, not just that the migration tool exited 0.

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
production at all, since the deployment target is managed Aiven Kafka,
not this project's own self-hosted Redpanda container. Noted here so it
isn't mistaken for a Dockerfile
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
- Render's free Web Service tier spins the container down after ~15min of
  no inbound HTTP traffic; the next request pays a cold-start penalty
  (seconds to ~30-60s). Accepted deliberately (2026-10-03) rather than
  worked around — this is a $0 learning deployment, not yet serving real
  traffic. Two consequences worth naming: (1) WebSocket connections to any
  open browser tab get dropped the moment the container sleeps — mitigated
  by useAuctionSocket.ts/useNotificationSocket.ts already implementing
  exponential-backoff reconnection (Section 14), so this resolves itself
  within the backoff window once the service wakes, not a broken app, just
  a few seconds of "disconnected"; (2) the Kafka consumers (outbox
  publisher, notification consumer, AI valuation worker) are the same
  Node process, so they also stop while asleep — events queue on Aiven's
  broker (3-day retention) until any request wakes the service again, not
  lost, just delayed.
```

## Consequences

- New `services/api/Dockerfile`, new root `.dockerignore`.
- `infrastructure/ai/ollamaClient.ts` and `ollamaValuationProvider.ts`
  changed (the real build-blocking type fix above) — 17/17 AI tests still
  passing, lint clean, confirmed via an actual `npm run build` + `tsc
  --noEmit`, not just one or the other.
- Nothing in `docker-compose.yml` changed — local dev continues exactly
  as before (native `npm run dev`, not containerized).

## Addendum (2026-10-03): Gmail SMTP doesn't work on Render, Brevo does

Found live, after real users couldn't get verification emails: Render's
free tier blocks outbound SMTP ports (25/465/587) entirely. `GmailEmailSender`'s
connection doesn't get refused, it just hangs — Render's firewall silently
drops the packets — until nodemailer's own timeout. Since `registerUser`
awaits the send inline (Section 24's fail-open try/catch still fires
eventually, but not before the whole HTTP request hangs with it), real
registration requests took 84-123+ seconds; one even hit Render's own
proxy timeout first and returned a bare 502 before the backend had even
responded, despite the backend continuing to process the request
underneath. Confirmed via three separate live registration attempts, zero
successful deliveries, cross-checked against independent reports of the
same Render free-tier SMTP block.

Two providers evaluated as the fix, in order:

1. **Resend** (HTTP API, not SMTP — sidesteps the port block entirely).
   Built, live-tested, confirmed working — but only to Resend's own
   account-verified email. Its free sandbox sender cannot reach arbitrary
   recipients without a verified sending domain (SPF/DKIM DNS records),
   and this deployment has no domain to verify (none owned, buying one
   wasn't an option). Kept in the codebase as a secondary option for
   later, once a domain exists.
2. **Brevo** (also HTTP API) — chosen instead because its verification
   requirement is a single confirmed email address, not domain DNS
   ownership. Live-tested with a real third-party recipient (a second,
   genuinely different Gmail address, not a `+alias` of the sender) —
   confirmed delivered. Real tradeoff, not hidden: without full domain
   authentication, Brevo routes mail through its own shared sending
   domain, so deliverability is weaker than a properly domain-
   authenticated sender (more likely flagged by strict filters,
   especially Gmail/Yahoo) — accepted since "reaches inbox or spam
   folder" beats both Resend's hard block and Gmail SMTP's failure modes
   by a wide margin.

`infrastructure/email/sender.ts`'s `createEmailSender()` now prefers Brevo
> Resend > Gmail SMTP > console fallback. Gmail SMTP stays only as the
local-dev path (no SMTP port block there). `GmailEmailSender` also picked
up explicit 10s connection/greeting/socket timeouts as defense-in-depth
(Section 67) — unrelated to which provider is active, but a real gap this
incident exposed: it previously had none at all.

## Addendum (2026-10-03): backend/database region mismatch made bids slow

Found live, from a direct user report ("bids take 1 sec, needs to be
sub-second"). Measured rather than guessed at, per Section 62:

- `placeBid`'s full path (service.ts + repository.ts) makes 9+ SEQUENTIAL
  network round trips: idempotency check, email-verification check, then
  inside one transaction — `SELECT ... FOR UPDATE` (the row lock), a
  second idempotency check, a previous-highest-bid lookup, the bid
  INSERT, the auction UPDATE, 1-2 outbox event INSERTs, COMMIT — plus one
  Redis call afterward to invalidate the auction cache. Every round trip
  here is real and necessary for Section 10's correctness guarantees
  (the row lock + re-checks are what closes the concurrent-bid race) —
  this is NOT bloat to trim.
- Measured each round trip's actual cost: `GET /readiness` (a single bare
  `SELECT 1`) took a STABLE ~500ms-1s even after the connection pool
  warmed up. For reference, a same-region query should be single-digit
  milliseconds. At 9+ round trips, even optimistic per-round-trip timing
  implied multiple seconds for a full bid — in the right range of what
  was actually felt.
- Root cause: the database (Supabase, `ap-northeast-1` / Tokyo — fixed at
  project creation, not changeable without migrating to a new project)
  and the backend (Render, Oregon / US West — picked without this in
  mind, since it was the first region offered during setup) are about as
  far apart as two regions can realistically be.
- Render's free tier offers exactly 5 regions (Oregon, Ohio, Virginia,
  Frankfurt, Singapore) and — critically — a service's region is fixed at
  creation and cannot be changed afterward. No literal Tokyo option
  exists; Singapore is the closest available. Stood up a SECOND Render
  service in Singapore (`auctionx-up1r.onrender.com`), re-verified every
  piece of infra against it (DB, Redis, Kafka, storage, email, CORS),
  then cut Vercel's `NEXT_PUBLIC_API_URL` over to it. The original Oregon
  service (`auctionx-app.onrender.com`) is being decommissioned.
- Result, measured the same way: the same `/readiness` single-round-trip
  check dropped from ~500ms-1s to a stable ~250-300ms from Singapore —
  roughly 2-3x faster, not a complete fix (Singapore-Tokyo is still real
  physical distance, just a much shorter hop than Oregon-Tokyo), but a
  genuine, measured improvement with zero code changes — this was
  entirely an infrastructure placement problem, not an application-layer
  one.
- Also repeated the EXACT same mistake as the first Render deploy while
  wiring this up: set `NEXT_PUBLIC_API_URL` to the bare new Render domain
  without the `/api/v1` suffix, breaking every API call again until
  caught and fixed the same way as before (remove the env var, re-add it
  correctly, redeploy — `NEXT_PUBLIC_` values are baked in at build time,
  so the env var change alone does nothing).

## Addendum (2026-10-03): cutting the bid path's round trips

After the Singapore move, bids still measured ~1.2-2.2s end to end (5
live bids, curl from outside Render, avg ~1.7s), and parallelizing the two
pre-transaction lookups (one saved round trip, ~275ms) wasn't measurable
through that ~1s run-to-run noise. The user's own observation narrowed it
further: reads felt fast, the *submit* (the write) felt as slow as before.
At ~275ms per Singapore<->Tokyo round trip, the round-trip COUNT is the
whole cost, so the fix is fewer round trips, not faster code:

- **Transaction body: up to 7 sequential statements -> 2.**
  `placeBidTransactionally` (bids/repository.ts) is now one locked read
  (`SELECT ... FOR UPDATE OF a`, with LEFT JOINs pulling the idempotency
  re-check and the previous highest bid into the same query) and one write
  (bid INSERT + auction UPDATE + reindex outbox INSERT + conditional outbid
  outbox INSERT, as a single statement of chained data-modifying CTEs).
  Same lock, same validation point, same rows written, same atomicity —
  only fewer network hops. Raw SQL means ids are generated in JS
  (`@default(uuid())` is Prisma-client-side; the columns have no DB
  default).
- **Pre-transaction lookups: 3 concurrent.** idempotency lookup, user
  lookup and the existing 5s auction cache (ADR-0017) in one `Promise.all`.
- **Redis fast-reject.** On a cache hit, the same `assertBidIsAcceptable`
  runs against the cached auction first, so a doomed bid (too low, ended,
  not active, own auction) is rejected without opening a transaction. It
  can only reject early, never accept early. Accepted, bounded risk: if a
  commit's cache invalidation never ran (crash/Redis outage in that gap),
  a stale endTime from before an anti-sniping extension could wrongly
  reject a valid bid for up to the 5s TTL — the same staleness bound
  ADR-0017 already accepts for reads.

Two things this surfaced:

- A raw-SQL unique violation comes back from Prisma as `P2010` (Postgres
  `23505` in `meta.code`), not `P2002`. The cross-auction idempotency-key
  race handler only checked `P2002`, so that race briefly returned 500
  instead of a replayed 201 — caught by the existing race test, fixed with
  `isUniqueViolation()` covering both shapes.
- No bid test checked outbox writes, so a broken CTE could have silently
  dropped search reindexing / outbid notifications while every bid test
  passed. Added a test asserting exactly one reindex event per accepted bid
  and an outbid event (with the right payload) only when another bidder is
  outbid.

Measured live after deploy (same auction, same client, 10 bids each):
accepted-bid median **~1080ms -> ~770ms**.

**Correction to the earlier "~250-300ms per DB round trip" figure:** that
was `/readiness` timed end to end from outside Render, so it included the
client<->Render network hop. Splitting it properly (medians of 9):
`/liveness` (no DB/Redis) ~222ms, `/readiness` (one `SELECT 1`) ~285ms,
cached `GET /auctions/:id` (two Redis calls) ~348ms. So one Render->Supabase
round trip is **~60ms**, one Render->Upstash call is also **~60ms**, and the
rest is the client's own distance to Singapore. The Singapore move was
still the right call (Oregon->Tokyo hops are far longer), but the per-hop
cost is ~60ms, not ~275ms.

Full suite: 191/191 passing under `--runInBand` (the project's `npm test`
mode). The notifications suite can't currently run locally — see the
Revisit Conditions entry on Redpanda's advertised address.

## Revisit Conditions

- If local Docker-based end-to-end testing against Redpanda is ever
  actually needed, revisit the advertised-listener config then (e.g. a
  second listener advertised for a Docker-internal hostname).
  **Now actually hit (2026-10-03):** local Redpanda advertises
  `localhost:9092`; on this Windows machine Node resolves `localhost` to
  `::1` first, and Docker resets IPv6 connections to that port. kafkajs
  bootstraps fine via `127.0.0.1` (KAFKA_BROKERS) but then follows the
  advertised `localhost` and gets `ECONNRESET` / "group coordinator not
  found", so tests/notifications times out locally. Fix: advertise
  `127.0.0.1:9092` instead (Redpanda's `--advertise-kafka-addr`) and
  restart the container. Unrelated to production (Aiven).
- The bid path is now 1 parallel lookup + 2 transaction round trips
  (+ commit). If it still needs to go lower, the next lever is collapsing
  the two transaction statements into a single stored procedure / one
  statement (the validation would have to move into SQL, which is why it
  wasn't done here), or a same-region database.
- Gmail's send cap concern is moot now — Gmail SMTP is no longer the
  production path at all (see the addendum above).
- If a domain is ever acquired for this project, switch back to Resend
  (verify the domain there, set `RESEND_FROM` to the new address) for
  better deliverability than Brevo's shared-domain routing — no code
  change needed, `createEmailSender()` already prefers Brevo only because
  no domain exists yet, not for any other reason.
- Once Admin panel + real Stripe land (the agreed next milestone), this
  ADR's provider list doesn't need to change — both are backend/frontend
  features deploying onto the exact same infra already planned here.
- If/when this gets real traffic, revisit the Render free-tier sleep
  behavior: either accept paying for an always-on instance, or move to a
  platform with faster cold starts (Fly.io's Firecracker VMs were
  considered and are a live option, not evaluated further since this
  wasn't yet a blocking concern for a $0 learning deployment).
- ~60ms per DB round trip (Singapore <-> Tokyo; see the correction in the
  round-trips addendum — the originally recorded ~250-300ms included the
  client's own network hop) is a real, accepted floor given free-tier
  region constraints, not a solved problem. If bid
  latency ever needs to go lower than that allows, the actual lever is
  reducing CROSS-REGION round trips, not adding more code: either a
  same-region (Tokyo-area or closer) paid Postgres host, or caching the
  auction row's lock-relevant fields (price/status/endTime) in Redis as a
  fast pre-check BEFORE opening the Postgres transaction — rejecting an
  obviously-stale bid in ~1 round trip instead of paying for the full
  transaction just to find out. Not implemented now — YAGNI until this is
  an actual measured problem again at the new baseline.
- Delete the original Oregon Render service (`auctionx-app.onrender.com`)
  once the Singapore one (`auctionx-up1r.onrender.com`) has had a bit more
  real usage confirming it's stable — kept alongside it temporarily as a
  rollback option during the cutover.

## Correction (2026-10-04, see ADR-0042)

The merged bid transaction's comments claimed the joined idempotency and
previous-top-bid reads happened "under the lock". They did not: in READ
COMMITTED only the locked auctions row is re-read after a lock wait; joined
tables keep the pre-wait snapshot. The previous-top-bid lookup now lives in the
write statement (fresh snapshot, lock held), bid createdAt uses
clock_timestamp(), and a retry that misses its twin is replayed by the service.
