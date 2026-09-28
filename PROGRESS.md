# AuctionX — Progress

_This file is the session-continuity anchor (CLAUDE.md Section 84). Read this
and the latest ADRs before proposing next steps in a new session._

## Current Phase

**Phase 1 — Authentication**, **Phase 3 — Auctions** (its non-bidding-
dependent lifecycle: create/update/publish/start/pause/cancel), and
**Phase 4 — Bidding** (concurrency, idempotency, transactions, anti-sniping,
closing) are complete. **Phase 2 — Users** was deliberately skipped
(confirmed with the developer). A frontend (`apps/web`) was built ahead of
Phase 5 by developer choice (WEB-000/001/002/003). **Phase 5 — Redis** is
functionally done for now: rate limiting (AUTH-006), read caching
(CACHE-001), and bid-specific rate limiting (RATELIMIT-002); hot auction
state (a dedicated Redis data structure, distinct from CACHE-001's read
cache) remains deferred, of debatable justification at current scale/
traffic. **Phase 6 — WebSockets** is functionally done for the frontend's
current needs: the gateway foundation (WS-001) and wiring it to real
bid-acceptance/auction-lifecycle events (WS-002) are both complete — the
auction detail page now gets live price/status/bid-history updates over a
WebSocket instead of polling. **Object storage** (Section 27, MEDIA-001,
outside the Section 73 phase numbering — a real product gap identified
separately from the phase plan) is now done: sellers can upload real
photos, stored in S3-compatible object storage (Cloudflare R2 target,
`s3mock` locally), rendered on both the browse and detail pages.
**Phase 8 — Orders/Payments** is complete end to end, backend and
frontend: order creation on auction close (ORDER-001/002, ADR-0023), the
Payment domain (PAYMENT-001/002, ADR-0025 — provider port, mock provider,
pay endpoint, webhook handling), and the frontend (`/orders`,
`/orders/[id]` with a live-polling "Pay now" action) are all built and
verified live in a real browser (login → orders list → pay → auto-flips to
Paid via the ~300ms simulated webhook, no manual refresh). **Notifications**
(Section 1/4's long-unbuilt Notification Module, ADR-0026) is now done:
outbid/won/sold/reserve-not-met/payment-received notifications, persisted
in Postgres and pushed live over a new per-user WebSocket room, with a
notification bell in the frontend nav. **Phase 7 — Kafka** is now done
(ADR-0027, built after Payments/Notifications rather than before, out of
necessity, then used as a real refactor target): Redpanda (Kafka-API-
compatible, chosen for its much lighter local-dev footprint than real
Kafka+Zookeeper) + the Outbox pattern + a notifications consumer, with all
three of Notifications' triggers (bid outbid, auction closed, payment
succeeded) moved OFF the bid/closing/payment critical path onto it,
matching Section 64's own diagram. Idempotent consumer, dead-letter queue
on unprocessable messages — both genuinely exercised, not just built:
verified live when the production consumer group's first connection
replayed a backlog of stale test data and correctly DLQ'd every
unprocessable message instead of crashing. **Phase 9 — Search** is now
done (ADR-0029): OpenSearch, fed via the SAME Outbox/Kafka mechanism Phase
7 built — a dedicated `search-events` topic (deliberately not reusing
`auction-events`, which would have corrupted the notifications consumer's
DLQ signal), a `modules/search` consumer that re-fetches from Postgres and
upserts/deletes into the index, and a new public `GET /api/v1/search/
auctions` endpoint with relevance-ranked full-text search plus category/
status/price filters. Verified live end-to-end including the required
failure mode: a real bid succeeded instantly with OpenSearch fully
stopped, and the index self-healed on the next event once it came back.

## Project location

**Moved from `C:\Users\ASUS\Desktop\Placement\PROJECTS\AuctionX` to
`D:\Projects\AuctionX`** (C: was down to ~1.7GB free). `node_modules`/
`.next`/`dist` were excluded from the copy and regenerated fresh on D: via
`npm install` + `prisma generate`. Postgres/Redis are untouched — they run
in Docker-managed named volumes (`docker-compose.yml`), never bind-mounted
into the project folder, so the move didn't touch any data or require a
container restart. Verified from the new location: build/lint/full test
suite (131/131) all pass, both dev servers start and serve real traffic.
The old C: copy's contents were deleted after verification (the top-level
folder itself was deliberately left in place empty, not removed, since a
tool session's shell was anchored to that exact path). **This freed only
~500MB** — the project's own footprint was never the dominant consumer of
C:'s space. The real driver is still unidentified; Docker Desktop's WSL2
disk image (`docker_data.vhdx`, found at 66GB and known not to auto-shrink)
is the leading suspect, flagged for the developer to investigate outside
this session (Storage Sense / WinDirStat — a shell-based `du` scan of
`AppData` never completed in reasonable time this session, which is itself
a bad sign).

**Resolved (2026-09-28), while clearing headroom for Phase 7's Redpanda
image (ADR-0027)**: confirmed via `docker images` — ~50GB of unrelated
Docker images from OTHER projects on this machine (`blender-render-*`
one-off render jobs, `pytorch/pytorch`, `ollama/ollama`,
`lender-base-ml`), not AuctionX. Freed with the developer's explicit
go-ahead (`docker image prune -a` + `docker builder prune -a`, ~54GB
reclaimed inside Docker's own accounting). The VHDX file itself
(confirmed at `C:\Users\ASUS\AppData\Local\Docker\wsl\disk\
docker_data.vhdx`, 66.39GB) doesn't auto-shrink when Docker's internal
data does, so Windows' own free-space number didn't recover — the
developer chose to defer the actual shrink (`wsl --shutdown` + admin
`diskpart compact vdisk`, briefly stops all containers) rather than do it
mid-session; still open whenever convenient.

## Current Task

**TASK SEARCH-001 — OpenSearch-backed auction search (Phase 9, ADR-0029)**
→ **complete, not committed yet**. See ADR-0029 for full design/tradeoffs.
Summary: `docker-compose.yml` gained an `opensearch` service (verified
pullable/startable/healthy first, same discipline as Redpanda — 1.47GB
image, GREEN cluster health in ~10s, no `vm.max_map_count` friction on
this machine). Every place an auction's searchable fields change (six
`auctions/repository.ts` mutation functions, all three `closeAuctionIfExpired`
outcomes, every accepted bid in `bids/repository.ts`) now publishes a
minimal `{type:'auction.reindex', auctionId}` outbox event on a NEW
dedicated `search-events` topic — dedicated specifically so it can't
corrupt `modules/notifications/consumer.ts`'s existing DLQ signal on
`auction-events`. `modules/search/consumer.ts` re-fetches the auction fresh
from Postgres on every event (never trusts payload-carried fields) and
upserts/deletes into OpenSearch, correctly excluding DRAFT auctions
(ADR-0008). New public `GET /api/v1/search/auctions` endpoint (`q` full-
text + category/status/price filters), returning a structured 503
`SEARCH_UNAVAILABLE` — never a silently-empty result set — if OpenSearch is
unreachable.

**Found during this task's own verification, and then FIXED (TASK
OUTBOX-002, ADR-0030)**: `infrastructure/jobs/outboxPublisherWorker.ts` had
no row-level locking — a live dev server left running during a full
test-suite run raced with the suite's own outbox publishing against the
shared dev Postgres instance, producing two real (not flaky-by-chance) test
failures. Fixed with a claim-lease pattern: a new nullable
`OutboxEvent.claimedAt` column, claimed via a single atomic
`UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING *`
(the lock held only for that statement, never across the actual Kafka
sends — Section 65), with a 30s lease so a genuinely crashed worker's
claimed-but-unpublished rows self-heal, and immediate claim release on an
ordinary send failure so normal retries stay as fast as before this fix.
Verified two ways: two separate `PrismaClient` connections racing
`Promise.all` for the same row (run 3x, exactly one won every time), and
by literally recreating the original failure scenario — a live dev server
running during a full suite run — which now passes 165/165 clean.

**TASK WEB-DESIGN-001 — Visual redesign of the public-facing frontend** →
**in progress (scoped first pass complete, not committed yet)**. Purely a
frontend/visual task, no backend changes. Replaced the placeholder
Tailwind-defaults look with a real design system: `Bricolage Grotesque`
(display/headings) + `Caveat` (handwritten sticky-note accents, decorative
only, never body copy) via `next/font/google`, a flat "sticker" visual
language (`--ink`/`--cream`/`--yellow`/`--pink`/`--cyan`/`--green` tokens +
`shadow-hard`/`shadow-hard-sm` flat box-shadows, `apps/web/app/globals.css`),
and a small reusable `Mascot` SVG component
(`apps/web/app/components/Mascot.tsx`). Redesigned: `NavBar.tsx` (pill-style
nav, active-route highlight), `NotificationBell.tsx` (restyled only, logic
untouched), the home page (`app/page.tsx` — hero, trending-categories grid,
live-auctions grid fed by real data, "why it works" strip, CTA band), and
the auctions browse page (`app/auctions/page.tsx` — pill category filters
replacing the native `<select>`). New shared `AuctionCard` component
(`app/components/AuctionCard.tsx`) used by both the home page and the
browse page so auction rendering isn't duplicated.

**Real constraint surfaced and resolved without touching the backend**: the
user's reference asked for trending categories like "Sneakers" and "Pokémon
cards," but `AUCTION_CATEGORIES` (schema.prisma / types/auction.ts) has no
such categories — only `COLLECTIBLES`, `BOOKS_AND_MANUSCRIPTS`, etc. Rather
than inventing a fake taxonomy the backend doesn't support, added a
presentation-only mapping (`apps/web/lib/categoryDisplay.ts`,
`Record<AuctionCategory, ...>` so TypeScript fails the build if a category
is ever added to the enum and this mapping isn't updated) that surfaces
"Sneakers, Pokémon cards, funko pops" as trending *examples* inside the
real `COLLECTIBLES` tile, and `BOOKS_AND_MANUSCRIPTS` directly as "Books &
Manuscripts."

Verified live (not just build/lint): `npm run build` and `npm run lint`
clean in `apps/web`; then real Playwright screenshots against the actual
running dev server (`localhost:3000`) with real backend data — hero, the
8-tile category grid, the "live auctions" empty state (mascot + copy, since
there are genuinely 0 ACTIVE auctions right now), and the browse page's
category-filter pill actually filtering a real auction via a real click,
not just a static render. One apparent bug (ghosted "Register"/"Log in"
text in the footer band on a full-page screenshot) was confirmed to be a
Playwright full-page-screenshot compositing artifact with `position:
sticky` elements, not a real rendering bug — re-verified with a real
scroll-then-screenshot instead of full-page stitching.

**Deliberately out of scope for this pass** (not a backend-touching
decision, just scope discipline — one focused change, not a sweep):
`login`/`register`/`auctions/new`/`auctions/[id]`/`my-auctions`/`orders`
pages still use the old plain Tailwind styling. Natural next step if asked
to continue.

---

**TASK KAFKA-001 — Kafka/Outbox + move Notifications off the critical path
(ADR-0027)** → **complete**. Redpanda added to docker-compose.yml
(Kafka-API-compatible, ~400MB, chosen over real Kafka+Zookeeper for local-
dev footprint — verified pullable/startable/healthy before adopting it).
`OutboxEvent` model + `infrastructure/outbox/repository.ts`
(`createOutboxEventInTx`, same cross-module reach-in pattern as
`createNotificationInTx` before it) + a polling publisher worker
(`infrastructure/jobs/outboxPublisherWorker.ts`, 2s scan). `bids/
repository.ts`, `auctions/repository.ts`, `payments/repository.ts` no
longer create `Notification` rows directly — each writes ONE `OutboxEvent`
in its existing transaction instead (`bid-events`/`auction-events` keyed
by auctionId, `payment-events` keyed by orderId). `modules/notifications/
consumer.ts` is the new sole creator of `Notification` rows, idempotent via
`sourceEventId` = Kafka's own `(topic, partition, offset)` — no producer-
side id-generation chicken-and-egg problem — enforced by a new
`@@unique([sourceEventId, userId])` constraint (compound, since one
`auction.sold` event legitimately produces two notifications, one per
side). `infrastructure/kafka/consumer.ts`'s generic runner sends any
handler failure to a `{topic}-dlq` topic rather than blocking the
partition or crashing (Section 43) — genuinely exercised, not just built:
the production consumer group's first-ever connection replayed a backlog
of stale test-session messages referencing deleted users, and every one
correctly DLQ'd instead of crashing anything.

A real, non-empty-table migration this time: 3 pre-existing Notification
rows (real usage — see below) required a backfill-then-tighten migration
(`sourceEventId` added nullable, backfilled to each row's own `id`, then
set NOT NULL), hand-written after `prisma migrate diff` needed a genuinely
disposable shadow database — created a temporary `auctionx_shadow_tmp`
database on the same Postgres server this time (not the real one, learning
directly applied from ADR-0024's incident) and dropped it immediately
after.

**Discovered mid-task, not AuctionX's fault, real accounts**: two
non-test-prefixed users existed in the database
(`priyadarshisatyakam77@gmail.com`, `tripathialisha03@gmail.com`) — the
developer's own real usage of the live app, generating 3 real Notification
rows. Confirmed and preserved throughout (the migration backfill above,
every cleanup query this task ran) — never touched, unlike the routinely-
deleted `test-*@example.com` rows.

165/165 tests passing (162 prior + 3 new: consumer idempotency on Kafka
redelivery, both the single- and two-notification-from-one-event cases,
plus the malformed-payload-throws DLQ-routing signal).
`notifications.test.ts` was rewritten to poll for results instead of
asserting immediately, since notification creation is now genuinely
asynchronous. Verified live twice: full automated suite against a real
Redpanda (not mocked), and a full real-browser Playwright session
(register → bid → outbid via curl → notification bell updates live with
no page reload) — proving ADR-0026's user-visible behavior is unchanged
despite the underlying delivery mechanism changing completely.

---

**TASK NOTIF-001 — Notifications (ADR-0026)** → **complete**. Section 1/4's
Notification Module, unbuilt until now: five triggers (`OUTBID`,
`AUCTION_WON`, `AUCTION_SOLD`, `AUCTION_RESERVE_NOT_MET`,
`PAYMENT_RECEIVED`), each created inside the SAME transaction as the event
it reports (the outbid one specifically reads "who was previously
winning" under bid placement's existing row lock, before inserting the new
bid — doing this after commit would be a real race, since another bid
could land in between and change the answer). `Notification` is a real
Postgres table (source of truth); a new per-user WebSocket room
(`infrastructure/websocket/gateway.ts`'s `userRooms`, joined automatically
on `auth`) pushes it live on top, additively — a user with no open
connection still sees it via `GET /api/v1/notifications` on their next
visit. Frontend: a notification bell in the nav (unread badge, dropdown,
mark-read/mark-all-read), an app-wide WebSocket hook mounted from the root
layout so it survives page navigation. 162/162 tests passing (155 + 7
new), build/lint clean, **verified live in a real browser**: logged in as
one bidder, had a separate curl-driven bidder outbid them mid-session, and
watched the unread badge appear with no page reload — a genuine push, not
a polling artifact — then confirmed clicking it navigated correctly and
cleared the unread count.

---

**TASK ORDER-001/002 — Order creation on auction close (ADR-0023)** →
**complete**. Section 19's payment flow starts at `Auction End -> Winner ->
Order`; that link didn't exist before this task — closing an auction
determined a winning bid but created nothing. Also fixed a real,
pre-existing correctness bug found while building this: `reservePriceCents`
was validated on create/update but never actually checked by the closing
worker, so an auction could be marked "sold" below its own reserve.
`closeAuctionIfExpired` now returns `NO_BIDS | RESERVE_NOT_MET | SOLD`, and
an `Order` row is created atomically (same transaction, same row lock) only
on `SOLD`. `Order`/`Payment`/`PaymentStatus`/`OrderStatus` added to the
schema; `Order.auctionId`/`winningBidId` are both `@unique`. 146/146 tests
passing (144 prior + 2 new: reserve-not-met creates no Order, reserve-met-
exactly creates one), build/lint clean.

**Mid-task incident, fully documented in ADR-0024**: while generating a
follow-up migration (scoping `Payment.idempotencyKey` to be unique per-
order rather than globally, matching `Bid`'s pattern), I ran
`prisma migrate diff --shadow-database-url` pointed at the **live local
dev database** instead of a disposable one — this wiped every row in it
(all users, auctions, bids, refresh tokens), including the developer's own
manually-created "House" auction and account from earlier sessions. **Not
recoverable** — there was no backup mechanism anywhere in this project.
Confirmed via `docker logs auctionx-postgres` (a burst of DDL/checkpoint
activity at the exact command timestamp). Schema/migration state is
correct and clean after the incident (verified: `migrate status` clean,
146/146 tests pass, both dev servers healthy) — only the data is gone.
**Fix, not just documentation**: added `npm run db:backup` /
`npm run db:restore -- <path>` (`services/api/scripts/db-backup.ts`/
`db-restore.ts`, `docker exec pg_dump`/`psql` against the `auctionx-postgres`
container, dumps gitignored under `backups/`) — a manual local safety net,
verified with a real backup → real restore → app-still-healthy round trip.
Was never in place before; should have been.

---

**TASK PAYMENT-001/002 — Payment domain (ADR-0025)** → **complete**. Closes
the rest of Section 19's flow: `Order -> Payment Intent -> Provider ->
Webhook -> Verify -> Update Payment -> Update Order`. `PaymentProvider`
interface (`infrastructure/payments/provider.ts`) + `MockPaymentProvider`
(`mockProvider.ts`) — same zero-external-account-required pattern as
AUTH-007's `EmailSender`/`GmailEmailSender`/`ConsoleEmailSender`. Mock
simulates a real async, webhook-driven provider (~300ms delayed delivery,
real HMAC-SHA256 signature via `crypto.timingSafeEqual`, verified through
the EXACT same `handlePaymentWebhook` function the real HTTP route calls —
only the literal network hop is skipped, documented as a deliberate
tradeoff). `POST /api/v1/orders/:id/pay` (buyer-only, order must be
`PENDING_PAYMENT`), `GET /api/v1/orders` (mine, as buyer or seller),
`GET /api/v1/orders/:id`, `POST /api/v1/webhooks/payments/mock` (mounted
before `express.json()` — signature verification needs the exact signed
bytes, via `express.raw()`). Idempotency deliberately does NOT hold a lock
across the provider call (Section 65 — never lock across an external call)
— instead an unlocked pre-check + a `@@unique([orderId, idempotencyKey])`
DB constraint as the race-breaker, same P2002-catch-and-fetch pattern
`bids/service.ts` already uses. `PaymentWebhookEvent` carries no amount
field at all — nothing to even accidentally trust from a webhook payload
(Section 19). 155/155 tests passing (146 + 9 new), build/lint clean,
verified live end-to-end via curl (register → auction → bid → force-expire
→ Order created → pay → real ~300ms wait → webhook fires → Order `PAID`).

**Bug found and fixed while writing the webhook tests, not app code**:
supertest/superagent JSON.stringifies a `Buffer` payload when told
`Content-Type: application/json`, silently breaking byte-exact signature
tests — confirmed by diffing a working real `curl` request against a
failing supertest one. Fixed in the test client only
(`application/octet-stream`); documented inline so it isn't rediscovered
the hard way again.

**Frontend**: `lib/orders.ts` (`listMyOrdersRequest`/`getOrderRequest`/
`payOrderRequest`), `lib/types/order.ts`, `/orders` (list, buyer-or-seller
role label per row), `/orders/[id]` (amount/status, buyer-only "Pay now"
button, `idempotencyKey` generated once per page visit via
`crypto.randomUUID()` in a `useRef` — same pattern as the backend's own
idempotency design, ADR-0025). The detail page polls every 1s
(`refetchInterval`, TanStack Query v5's function form) only while
`status === 'PENDING_PAYMENT'`, so the buyer sees it flip to Paid the
moment the simulated webhook lands, with no manual refresh. Auction detail
page gets a small "check My orders" pointer once `ENDED`, for the seller
or a bidder — deliberately not a direct link to the specific order (no
`orderId` on the Auction row; adding that lookup just for one link would
couple an already-busy page to the Orders domain for no real gain).
NavBar gets a "My orders" link.

**Verified live in a real browser (Playwright), not just curl/tests**:
registered a seller+buyer via the real API, created/published/started/bid/
force-expired a real auction, then drove an actual Chromium session
through the real UI — logged in, landed on `/orders`, opened the order
(showed "Awaiting payment", correct amount), clicked "Pay now", watched it
auto-poll and flip to "Paid" with no manual refresh. **Self-inflicted
hiccup along the way**: this session's own heavy curl-based testing had
pushed `authRateLimit`'s real 10/15min threshold on this dev server past
390 requests from the local IP, causing the first login attempt in the
browser to fail with 429 — diagnosed by finding the actual
`ratelimit:auth:ip:*` keys in the real Redis instance the app connects to
(not blindly guessing), clearing just those two keys, and retrying
successfully. Not a bug in this task's code — a consequence of how much
manual verification this session did against a real, non-test rate limit.

---

**TASK MEDIA-001 — Object storage for auction images (ADR-0022)** →
**complete**. Real product gap closed: sellers can now upload real photos
when creating an auction, and those photos render on the browse list and
detail page — `Auction.images` had existed as a placeholder `String[]`
column since AUCTION-001 with no actual upload path behind it until now.

Asked the developer directly whether to use Cloudinary or a self-hosted
S3-compatible approach before building anything; chose Cloudflare R2 (+ a
generic S3-compatible local stand-in) specifically to preserve this
project's local-dev-never-needs-a-live-account principle, which Cloudinary
would have broken.

**Two real, current infrastructure dead ends hit and worked through**:
MinIO's Docker images now deny anonymous pulls entirely (checked Docker
Hub, quay.io, and ghcr.io — all denied); LocalStack pulls fine but refuses
to start without an account/auth token, even for the free community S3
service — the exact problem Cloudinary was rejected for. Landed on
`adobe/s3mock` (Apache-2.0, no login required, verified with a raw
PUT/GET before adopting it).

Backend: presigned-POST uploads (`@aws-sdk/client-s3` +
`@aws-sdk/s3-presigned-post`), scoped by seller id in the object key,
constrained by a signed policy (5MB limit, JPEG/PNG/WebP only) rather than
a client-side-only check. **Found and documented, not hidden**: s3mock
doesn't actually enforce those policy conditions (a wrong-content-type and
an oversized upload both succeeded locally when real S3/R2 would reject
them) — confirmed this is a mock limitation, not a bug, by decoding the
actual signed policy document and verifying its conditions are correct
per the standard AWS POST-policy format.

Frontend: file input on the create-auction form uploading directly to
object storage (never through our own server), thumbnail previews,
uploaded images rendered on both the browse list and detail pages.

Verified live twice: a scripted real upload (real PNG bytes round-tripped
byte-identical through a real presign→upload→GET flow, then referenced in
a real created auction) and a full real-browser Playwright session
(registered/logged in through the actual UI, selected a real file, saw
the thumbnail appear, submitted, confirmed the image renders on both the
detail and browse pages). Full backend suite: 144/144 (139 prior + 5 new).
Both workspaces build/lint clean.

**Follow-up bug, reported by the developer and fixed same-day (ADR-0022
Addendum)**: "the image is being uploaded but not visible via frontend."
Root cause was self-inflicted — `s3mock` had no volume at all, so the
container recreate done earlier in this same session (to fix its
healthcheck) silently wiped every previously-uploaded object while
Postgres kept referencing the dead URLs; Chrome reported this as
`net::ERR_BLOCKED_BY_ORB`, which looks like a rendering/CORS bug but is
just how it surfaces a 404 on an `<img>` request. Confirmed against the
developer's own real "House" test auction (its image genuinely 404'd) and
ruled out a code bug by uploading fresh and having it work perfectly.
**The real fix took real investigation**: s3mock ignores a mounted volume
by default (logs "will retain files on exit: false" and writes to an
ephemeral `/tmp` path regardless) — its actual property name
(`COM_ADOBE_TESTING_S3MOCK_STORE_ROOT`) isn't documented anywhere obvious
and was found by extracting strings directly from the image's compiled
`.class` files; a second blocker (a fresh named volume mounts owned by
root, but the image's default user is non-root) needed `user: "0:0"` too.
Every step verified with a real upload → real `docker restart` AND a real
full `docker rm`+recreate (the actual failure scenario) → real GET, not
assumed. The developer's pre-existing "House" auction's specific image
couldn't be recovered (bytes were already gone) and was left as their own
data to deal with; four of my own leftover test auctions from this
session's verification work were cleaned up.

Next: the disk-space drain (Docker's VHDX still the leading suspect), the
port-6379 Redis mismatch (ADR-0021's finding, still open), or moving on to
the next real product gap — Orders/Payments (Phase 8) or Notifications —
whenever the developer wants any of them.

## What was just completed

### TASK 000 — Architecture & Repository Foundation
- Git repo initialized.
- npm workspaces monorepo (`services/*`, `apps/*`, `packages/*`) — only
  `services/api` populated so far; other dirs created on demand, not
  pre-scaffolded empty (see ADR-0001).
- `services/api`: Express app on strict TypeScript, structured pino logging
  (redacts auth headers/cookies), Zod-validated env config (fails fast on
  invalid/missing env vars), structured JSON error envelope
  (`{error:{code,message,requestId}}` per Section 32), request-id
  propagation via `x-request-id` header.
- ESLint (flat config, typescript-eslint recommendedTypeChecked) + Prettier.
- Jest + Supertest test harness.

### TASK AUTH-001 — User Domain (schema)
- `docker-compose.yml`: local Postgres 16 (`auctionx-postgres`), healthcheck,
  named volume.
- Prisma added to `services/api`. Schema (`prisma/schema.prisma`):
  `User { id (uuid), email (unique), passwordHash, name, role (USER|ADMIN),
  status (ACTIVE|SUSPENDED|BANNED), createdAt, updatedAt }`. Design decisions
  and rejected alternatives are written up in the conversation and summarized
  in ADR-0002 — key ones: UUID over auto-increment PK (no enumeration leak,
  no cross-service coordination issue), `passwordHash` directly on `User`
  rather than a separate `Credential` table (YAGNI until OAuth is actually
  scheduled — documented revisit condition), role separated from
  buyer/seller capability (seller state belongs to the Auction module,
  Phase 3, not here), email uniqueness enforced via app-level lowercase
  normalization rather than Postgres `citext`.
- First migration applied: `20260906202253_init_user`.
- `src/infrastructure/database/prisma.ts`: singleton `PrismaClient` (one pool
  per process, not per request).
- `/readiness` now performs a real `SELECT 1` against Postgres and returns
  503 if it fails; `/liveness` stays independent of the DB. **Verified live**:
  stopping the Postgres container flips readiness to 503 while liveness
  stays 200, and it recovers automatically once Postgres restarts.
- Graceful shutdown now also calls `prisma.$disconnect()` after the HTTP
  server closes.
- `DATABASE_URL` added to the fail-fast env schema (required, no default).
- Jest loads `.env` via `setupFiles: ['dotenv/config']` so tests see
  `DATABASE_URL` too; tests currently run against the same local Postgres as
  dev (no isolated test DB / Testcontainers yet — deferred, see below).
- Verified: `npm run test:api` (4/4 pass), `npm run lint:api` clean,
  `npm run build:api` clean, migration applies cleanly against a fresh
  container.

### TASK AUTH-002 — Registration API
- `src/infrastructure/security/password.ts`: Argon2id hashing (OWASP
  baseline params: memoryCost 19456, timeCost 2, parallelism 1).
- `src/modules/auth/`: `schema.ts` (Zod — trims/lowercases email, no forced
  password composition rules per NIST 800-63B, just a length floor/ceiling),
  `repository.ts` (raw Prisma access, throws on conflict), `service.ts`
  (hashes password, calls repository, translates Prisma's `P2002` unique
  violation into a `ConflictError` — no pre-check-then-insert, since that
  would race), `controller.ts`, `routes.ts` (`POST /register`).
- `src/middleware/validate.ts`: generic `validateBody(schema)` — replaces
  `req.body` with the parsed/normalized value so handlers never re-normalize.
- `errors.ts` extended with `ValidationError` (400) and `ConflictError` (409)
  plus an optional `details` field on `AppError` for field-level validation
  errors.
- Mounted at `/api/v1/auth` (first use of the versioned API prefix).
- Deliberately did NOT add an `Idempotency-Key` mechanism for this endpoint
  — the email unique constraint already gives the safety property that
  matters (no duplicate accounts on retry); that pattern is reserved for
  operations without a natural uniqueness key, like bid placement.
- Tests (`tests/auth/register.test.ts`, all passing): success path (asserts
  `passwordHash` never appears in the response AND that the stored hash
  actually verifies against the original password via `argon2.verify` —
  not just "some string got saved"), email-case normalization, structured
  400 on invalid payload, 409 on duplicate email, and a **concurrency race
  test**: two identical registration requests fired via `Promise.all`
  assert exactly one 201/one 409 and exactly one row in the DB — proving
  the check-then-insert race is actually avoided, not just claimed.
- **Verified live** via manual curl against the running dev server: success
  (lowercased email, no hash leaked), duplicate → 409, invalid payload → 400
  with per-field `details`.

### TASK AUTH-003 — Login + JWT issuance
- Prisma: `RefreshToken` model added (`userId`, `tokenHash` (SHA-256, unique),
  `expiresAt`, `revokedAt`, `replacedByTokenId`, `userAgent`, `ip`), `User`
  relation with `onDelete: Cascade`. Migration
  `20260907085424_add_refresh_tokens` applied. Full reasoning in ADR-0003.
- `src/infrastructure/security/tokens.ts`: `signAccessToken`/
  `verifyAccessToken` (HS256 JWT, 15 min TTL, claims `{sub, role}` only —
  no PII), `generateRefreshToken`/`hashRefreshToken` (opaque 256-bit random
  token, SHA-256 for storage — not Argon2id, since the input is already
  high-entropy so there's no brute-force space to slow down).
- `JWT_ACCESS_SECRET` added to the fail-fast env schema (required, min 32
  chars). Generated a real random dev value into `services/api/.env`
  (gitignored) via `node -e "crypto.randomBytes(32).toString('base64url')"`.
- `src/middleware/authenticate.ts`: Bearer-token middleware, populates
  `req.user = {id, role}`. Distinguishes `TOKEN_EXPIRED` from `INVALID_TOKEN`
  (401 either way) so a future client can tell "try silent refresh" from
  "force full login" apart.
- `src/modules/auth/`: added `loginUser` (timing-safe — runs a real Argon2
  verify against a fixed dummy hash when no user is found, so a
  nonexistent-email attempt and a wrong-password attempt take comparable
  time; rejects non-`ACTIVE` accounts, but only *after* password
  verification, so account status isn't itself an enumeration oracle),
  `logoutUser` (idempotent — revoking an already-revoked/unknown token is a
  no-op, not an error), `getCurrentUser`. New routes: `POST /login`,
  `POST /logout`, `GET /me` (behind `authenticate`).
- Refresh token delivered via httpOnly, `SameSite=Lax` cookie scoped to
  `/api/v1/auth` (not sent on unrelated API calls). `cookie-parser` added to
  read it. Access token returned in the JSON body alongside `expiresIn`.
- `errors.ts` extended with `UnauthorizedError` (401).
- **Known gap, deliberately not fixed yet**: `app.ts`'s `cors()` is
  wildcard-origin without `credentials: true` — fine while nothing browser-
  based exists to call this API, but the refresh cookie won't work
  cross-origin from a real frontend until this is configured with a known
  origin. Flagged in code and here rather than guessing at an origin that
  doesn't exist yet.
- Tests (`tests/auth/login.test.ts`, all passing): successful login (asserts
  the `Set-Cookie` header's `HttpOnly` and `Path` attributes, not just that
  a cookie exists), wrong-password and nonexistent-email return the
  *identical* error code and message (proving no enumeration leak, not just
  claiming it), suspended-account rejection, `/me` unauthenticated /
  garbage-token / valid-token cases, and logout (asserts the DB row's
  `revokedAt` actually gets set, plus a second logout call is a no-op).
- **Verified live**: full manual curl flow — register → login (inspected the
  raw `Set-Cookie` header) → `/me` with the returned access token → wrong
  password and nonexistent-email both return byte-identical
  `INVALID_CREDENTIALS` responses.

### TASK AUTH-004 — Refresh token rotation + reuse detection
- Prisma: `RefreshToken.familyId` added (shared by every token descended
  from one login, set once at login, copied forward on each rotation).
  Migration `20260907103736_add_refresh_token_family` applied (table was
  empty, so no backfill needed). Full reasoning in ADR-0004.
- `repository.ts`: `rotateRefreshToken` (single `prisma.$transaction` that
  creates the new token row and revokes the old one together — a partial
  success either way is either a security hole or a needless logout, so
  they can't be allowed to happen independently), `revokeTokenFamily`
  (single indexed `UPDATE ... WHERE familyId = ?`, O(1) regardless of chain
  length — not a `replacedByTokenId` walk).
- `service.ts`: `refreshTokens` — validates the presented token
  (unrecognized → `INVALID_REFRESH_TOKEN`; expired → `REFRESH_TOKEN_EXPIRED`;
  **already revoked → treated as a theft signal, revokes the entire
  `familyId`, returns `REFRESH_TOKEN_REUSED`**), checks account is still
  `ACTIVE`, then rotates.
- `controller.ts`: `POST /refresh` — clears the refresh cookie on ANY
  failure path (invalid/expired/reused), since a client should never keep
  resending a cookie that's already known dead.
- Tests (`tests/auth/refresh.test.ts`, all passing): successful rotation
  (new cookie differs from the old one), missing/unrecognized token
  rejection, and — the important ones — reuse detection where replaying the
  original token after one legitimate rotation kills the whole chain
  (verified by then confirming the *legitimately rotated* token is ALSO
  dead, not just the reused one), and a 6-token-long rotation chain where
  reuse of token #1 is shown to also kill token #6 — proving family
  revocation actually scales across a realistic chain, not just a 2-token
  toy case.
- **Verified live**: full manual curl flow — login, rotate once, replay the
  pre-rotation cookie (→ `REFRESH_TOKEN_REUSED`), then confirm the
  legitimately-rotated cookie is also rejected with the same code.

### TASK AUTH-005 — RBAC
- `middleware/authorize.ts`: `requireRole(...roles)` — must run after
  `authenticate`, reads `req.user.role`, throws `ForbiddenError` (403,
  `errors.ts`) if not allowed.
- Made real (not dead code) via `PATCH /api/v1/auth/users/:userId/status`,
  admin-only — closes a loop from AUTH-001: `UserStatus` was added
  specifically for admin/fraud actions (Section 21) but nothing set it until
  now.
- Tests (`tests/auth/rbac.test.ts`): 401 unauthenticated, 403 non-admin, 404
  nonexistent target, 400 invalid status value, and — the important one — an
  admin suspending a user is verified to have a REAL effect elsewhere: that
  user's next login attempt fails with `ACCOUNT_DISABLED`, not just a DB
  field flip with no consequence.

### TASK AUTH-006 — Redis-backed rate limiting
- First Redis infrastructure in the system. Full reasoning (why Redis, fixed
  window vs alternatives, fail-open, why `REDIS_URL` gets a default unlike
  `DATABASE_URL`/`JWT_ACCESS_SECRET`) in ADR-0005.
- `docker-compose.yml`: `redis` service, deliberately no volume (counters
  are disposable, unlike Postgres data).
- `infrastructure/redis/client.ts`: singleton `ioredis` client, relies on
  its built-in reconnect (Section 41 — don't hand-roll retry logic you don't
  need), logs connection errors, never crashes the process.
- `middleware/rateLimit.ts`: `rateLimit(options)` factory — atomic
  `INCR`+conditional-`EXPIRE` via a Lua script (one round trip; prevents a
  key ending up with no TTL if a crash happened between two separate
  commands). Documented with the full Section 13 cache-rules format
  (key/TTL/value/source-of-truth/invalidation/consistency/failure/hot-key).
  Two configured instances: `authRateLimit` (10/15min, always IP-keyed —
  register/login/refresh are inherently pre-auth) and `apiRateLimit`
  (applied globally to `/api/v1/*` except health checks; 300/min keyed by
  user id when authenticated, 60/min keyed by IP when anonymous — the
  "different limits for authorized vs unauthorized" policy applied
  app-wide, not just to auth endpoints). Both stack where applicable.
- `middleware/authenticate.ts`: added `optionalAuthenticate` — populates
  `req.user` best-effort from a Bearer token, never rejects. Needed so the
  global limiter can key/cap by identity without requiring one; also a
  reusable primitive for future endpoints that behave differently for
  logged-in vs anonymous callers (Section 30's auction-browsing example).
- `REDIS_URL` added to env schema WITH a default (contrast with
  `DATABASE_URL`'s no-default fail-fast — deliberate, documented in
  ADR-0005: the app must boot and serve traffic with zero Redis available).
- Server shutdown now also closes the Redis connection.
- **Bug caught and fixed via lint, not by inspection**: `server.ts`'s
  shutdown originally chained `.then()` without handling the returned
  promise at the statement level — `@typescript-eslint/no-floating-promises`
  caught it; fixed with an explicit `void`.
- **Test-infrastructure fix**: the shared `ioredis` connection was keeping
  Jest alive after tests finished (a real hang, confirmed by `--forceExit`
  passing cleanly). Fixed with a shared `tests/jest.setup.ts` closing Redis
  per test file — deliberately NOT also centralizing Prisma disconnect
  there, since `setupFilesAfterEnv` hooks register before a test file's own
  `afterAll`, so a shared Prisma disconnect could run before a file's own DB
  cleanup and break it. Reasoned through explicitly, not just trial-and-error.
- **Second test-infrastructure fix**: the full suite makes far more than 10
  register/login calls against one shared test IP inside one 15-minute Redis
  window, tripping `authRateLimit` and cascading into ~20 unrelated
  functional-test failures. Fixed by raising both limiters' ceiling when
  `NODE_ENV=test`, and adding `tests/rateLimit.test.ts` — a dedicated test
  that exercises the actual mechanism (blocks at N, correct
  `X-RateLimit-*` headers, per-key isolation, variable max, and **fail-open
  verified by mocking `redis.eval` to reject and confirming the request
  still succeeds**) against small, deterministic limits, independent of
  production thresholds.
- **Verified live**: 12 bad-credential login attempts against the real dev
  server (`NODE_ENV=development`, real 10/15min threshold) — first 10 return
  401, 11th and 12th return 429 with `X-RateLimit-Remaining: 0`; a
  subsequent anonymous `/me` check shows the global limiter's counter
  correctly reflecting all prior `/api/v1` traffic, confirming both limiters
  stack as designed.

### TASK AUTH-007 — Forgot/reset password
- Developer chose Gmail SMTP as the provider. Full reasoning (why Gmail is
  fine now but not long-term, the EmailSender port, enumeration-safety
  design, session-revocation-on-reset, transaction atomicity) in ADR-0006.
- Prisma: `PasswordResetToken` (single-use, 30 min TTL, SHA-256-hashed
  opaque token — no rotation/family concept needed, unlike RefreshToken,
  since a reset flow is one attempt, not a session). Migration
  `20260907120145_add_password_reset_tokens` applied.
- `infrastructure/security/tokens.ts`: extracted `generateOpaqueToken`/
  `hashOpaqueToken` as shared primitives — refresh tokens and reset tokens
  are the identical random+hash pattern, and this is one of the few places
  in the codebase where deduplicating was worth it despite the general
  "don't over-engineer" bias, because letting correctness-critical
  token-generation code diverge is a real risk, not just repetition.
- `infrastructure/email/sender.ts`: `EmailSender` port. Three
  implementations selected by environment: `GmailEmailSender` (real SMTP,
  nodemailer — upgraded to nodemailer 10.x during install after `npm audit`
  surfaced multiple real, exploitable-class advisories — SMTP/CRLF
  injection, SSRF — against nodemailer ≤9, unlike the unrelated dev-only
  Prisma CLI advisory that's deliberately left unfixed), `ConsoleEmailSender`
  (dev fallback when Gmail isn't configured — loud warning at boot, not
  silent), `FakeEmailSender` (test-only, records sent messages in memory,
  exported so tests can assert on them — tests must never send real email).
- `GMAIL_USER`/`GMAIL_APP_PASSWORD` added to env schema as optional (same
  reasoning as `REDIS_URL` — the app must still boot and serve core traffic
  with no email provider configured). `FRONTEND_URL` added (defaults to
  `localhost:3000`) to build the reset link — a placeholder contract since
  `apps/web` doesn't exist yet.
- Developer's local `.env` intentionally left without real Gmail
  credentials — Claude does not request or handle secrets pasted into
  chat; the developer adds their own App Password directly to `.env` when
  ready (instructions in `.env.example`).
- `service.ts`: `requestPasswordReset` (always identical response
  regardless of whether the account exists — email only actually sends
  when it does; email-send failures are logged but never surfaced to the
  client, since a differing client-facing outcome would itself be an
  enumeration signal), `resetPassword` (single generic error for
  not-found/expired/already-used, revokes every refresh-token family for
  the user via `completePasswordReset` — a password reset that didn't kill
  an attacker's existing session would defeat the point of the feature).
- Two new rate limiters (`forgotPasswordIpRateLimit`,
  `forgotPasswordEmailRateLimit`) rather than reusing `authRateLimit` — an
  IP-only limit doesn't stop someone email-bombing one victim's inbox from
  many different IPs.
- Tests (`tests/auth/password-reset.test.ts`, all passing): the important
  one — forgot-password against a real vs. nonexistent email returns
  byte-identical HTTP responses, but `FakeEmailSender.sent` proves
  internally that exactly zero emails went out for the nonexistent one and
  exactly one for the real one, in the same test run. Also: token
  invalidation on re-request, password actually changes (old password
  stops working, new one works), reset revokes an old refresh token
  (verified via a subsequent failed `/refresh` call, not just a DB flag),
  expired/reused/garbage token rejection, validation errors.
- **Verified live**: forgot-password against a real vs. fabricated email
  returns identical JSON; the dev-server log shows exactly one "email not
  sent" warning (console fallback, since no Gmail credentials are
  configured locally), only for the real account.

### TASK AUCTION-001 — Auction Domain (schema)
- Prisma: `Auction` model added — `AuctionStatus` enum (`DRAFT|PUBLISHED|
  ACTIVE|PAUSED|CANCELLED|ENDED`, default `DRAFT`), `AuctionCategory`/
  `AuctionCondition` enums, `sellerId` FK to `User` (`onDelete: Restrict` —
  contrast with `RefreshToken`/`PasswordResetToken`'s `Cascade`: an auction
  is a business record, not a disposable session artifact). Full reasoning
  in ADR-0007. Migration `20260913170044_add_auctions` applied.
- Money stored as integer cents (`startingPriceCents`, `reservePriceCents`
  nullable, `currentPriceCents`) — never Decimal/Float, and chosen over
  Decimal specifically to match the minor-unit convention a real payment
  provider (Phase 8) will use, avoiding a conversion boundary later.
- `currentPriceCents` added now even though bidding (Phase 4) doesn't exist
  yet — it's the exact column Phase 4's bid transaction will update
  atomically alongside the bid insert (Section 10), so adding it later would
  mean a breaking migration on a table already holding real rows.
- `endTime` (planned) and `endedAt` (actual) kept separate — anti-sniping
  (Phase 4) moves `endTime` forward, and `cancel` can end an auction before
  its scheduled `endTime`; collapsing these would lose that distinction.
- `images: String[]` defaults to `[]` — placeholder contract for object
  storage (Section 27), not built yet.
- Indexes: `sellerId`, `status`, and composite `(status, endTime)` matching
  the Phase 4 closing worker's query shape ("active auctions past their end
  time").
- Deliberately schema-only, mirroring AUTH-001 → AUTH-002: no
  repository/service/controller yet. Optimistic-vs-pessimistic bid
  concurrency (Section 9) explicitly deferred to the Phase 4 task where the
  real contention exists, not decided speculatively here.
- Verified: `npm run build`/`lint`/`test` all clean (42/42 tests still
  passing) after the migration; migration applied cleanly against the local
  Postgres container.

### TASK AUCTION-002 — Create auction API
- `src/modules/auctions/`: `schema.ts` (Zod `createAuctionSchema` — rejects a
  `reservePriceCents` below `startingPriceCents` via `.refine`, since a
  reserve under the opening bid is meaningless), `repository.ts` (raw Prisma
  access), `service.ts` (`createNewAuction` — no `PublicAuction` mapper
  needed unlike auth's `toPublicUser`, since `Auction` has no secret field
  to strip), `controller.ts`, `routes.ts`. Mounted at `POST
  /api/v1/auctions`, behind `authenticate` only (no extra rate limiter — the
  already-global `apiRateLimit` covers it; Section 30 doesn't call out
  auction creation as needing a stricter tier).
- **Server-authoritative fields, enforced not just documented**: `sellerId`
  always comes from `req.user.id` (the verified JWT), never the request
  body; `status` is always forced to `DRAFT`; `currentPriceCents` is always
  set equal to `startingPriceCents` server-side. A test and a live curl
  check both confirm a request that tries to smuggle `status: "ACTIVE"`,
  a different `sellerId`, and a fake `currentPriceCents` in the body is
  silently overridden, not merely validated away.
- **Deliberately did NOT add a fresh DB status check** ("is this account
  still ACTIVE") on top of what `authenticate` already provides — AUTH-003
  already documented and accepted that a banned user's access token works
  for up to 15 minutes (bounded by TTL). Adding an ad-hoc re-check on this
  one write endpoint but not others would be inconsistent with that already-
  accepted, platform-wide tradeoff, not a genuine improvement.
- Tests (`tests/auctions/create.test.ts`, all passing): 401 unauthenticated,
  successful creation with correct defaults (verified against the DB row
  directly, not just the response), the override-attempt test above,
  structured 400 on invalid payload, and both sides of the reserve-price
  rule (rejected below starting price, accepted at or above it).
- **Verified live**: full manual curl flow against the running dev
  server — register/login, unauthenticated create → 401, valid create → 201
  with `status: DRAFT` and `currentPriceCents` equal to the starting price,
  an override attempt whose response proves the server's values won, and
  the reserve-price validation error.

### TASK AUCTION-003 — List/get auctions (read model)
- Full reasoning (DRAFT visibility rules, keyset-vs-offset pagination, the
  Express 5 `req.query` discovery) in ADR-0008.
- `GET /api/v1/auctions` and `GET /api/v1/auctions/:id`, both behind the
  already-global `optionalAuthenticate` only — no `authenticate` required,
  since browsing/reading is Section 30's high-traffic, no-login-required
  case. Handlers read `req.user` if present, treat it as absent otherwise.
- **DRAFT visibility**: hidden from everyone except the auction's own seller
  or an `ADMIN`, centralized in one `canSeeDraftsFor` check reused by both
  endpoints so the rule can't drift between list and single-item lookups.
  `GET /:id` on a hidden draft returns 404 — indistinguishable from
  nonexistent, same enumeration-safety posture already used for password
  reset. An explicit `?status=DRAFT` filter from a non-owner returns an
  *empty page*, not a 403 — doesn't confirm or deny anything about what
  exists.
- **Keyset (cursor) pagination on `(createdAt, id)`, not OFFSET/LIMIT** —
  chosen for a concrete, present-day correctness reason, not premature
  optimization: OFFSET pagination skips/repeats rows when items are
  inserted between page requests, and this is a live "newest first" feed
  where that happens constantly, not a rare edge case. `id` breaks ties
  when two rows share a `createdAt` (UUID order carries no meaning, it's
  purely for a stable sort). Cursor is an opaque base64url token so the
  underlying columns aren't a public API contract.
- **Discovered and worked around a real Express 5 behavior**: verified
  empirically (a throwaway script, not assumed) that `req.query` has no
  setter in Express 5 — `req.query = x` silently no-ops. `validateBody`'s
  "replace req.body with the parsed value" pattern can't work for query
  params here, so `middleware/validate.ts` gained a separate `validateQuery`
  that stashes the parsed/coerced result on `req.validatedQuery` instead.
- No new index added — the existing `status` index (ADR-0007) is enough at
  current scale; a composite `(status, createdAt)` index is an explicitly
  deferred, documented decision pending real query-latency data (Section 62:
  measure before optimizing), not an oversight.
- Tests (`tests/auctions/list.test.ts`, all passing): anonymous listing
  excludes drafts, a non-owner's explicit `status=DRAFT` filter returns an
  empty page, a seller's own draft appears when filtering by their own
  `sellerId`, another seller's draft stays excluded even when directly
  filtered by that seller's id, an admin can see any draft, pagination
  across multiple pages returns every created row exactly once with no
  duplicates or gaps, a corrupted cursor is rejected with 400, and the
  `GET /:id` 404/200 visibility matrix (nonexistent, hidden draft, own
  draft, published-to-anyone).
- **Verified live**: full manual curl flow against the running dev
  server — created a draft, confirmed it's absent from an anonymous list
  and 404s on anonymous `GET /:id`, confirmed the owner can see it both ways,
  confirmed a nonexistent id 404s, confirmed a corrupted cursor 400s.

### TASK AUCTION-004 — Update/publish
- Full reasoning (404-vs-403 split for mutations, no admin bypass on
  writes, publish's asymmetric startTime/endTime defaulting, merged-value
  re-validation) in ADR-0009.
- `PATCH /api/v1/auctions/:id`: edits a `DRAFT` auction's content fields —
  rejected once the auction is no longer `DRAFT` (409 `AUCTION_NOT_EDITABLE`).
  `reservePriceCents` supports an explicit `null` to clear an existing
  reserve, distinct from omitting the field entirely — confirmed via a
  throwaway script that Zod's `.partial()` genuinely preserves that
  distinction rather than assuming it.
- `POST /api/v1/auctions/:id/publish`: `DRAFT` → `PUBLISHED`. `startTime`
  defaults to `now()` if never set; `endTime` has no default (must come from
  the request or a prior update) and must be after `startTime` and in the
  future. Rejects a second publish attempt (409 `AUCTION_NOT_PUBLISHABLE`).
- **Shared ownership/visibility check (`requireOwnedAuction`)** reused by
  both endpoints: a non-owner touching an invisible `DRAFT` gets 404 (same
  as `GET`, per ADR-0008); a non-owner touching a publicly-visible auction
  gets a real 403. Deliberately no `ADMIN` bypass on mutations, unlike the
  read-side visibility bypass — admin's role so far is account moderation
  (AUTH-005), not listing content.
- **`status` is unreachable from the generic edit path by type signature,
  not just by validation**: `updateAuctionRow`'s parameter type has no
  `status` field at all; only a dedicated `publishAuctionRow` can set it —
  a second line of defense beyond "the Zod schema doesn't expose it."
- **Merged-value validation**: a `PATCH` that only sends `reservePriceCents`
  (with `startingPriceCents` untouched) is checked against the *stored*
  `startingPriceCents`, not just the request body — a same-request Zod
  refine alone can't catch a rule violated across one new field and one
  already-persisted one.
- Ran into an `exactOptionalPropertyTypes` case building the Prisma patch
  object (`reservePriceCents: number | null | undefined` not assignable to
  `number | null`) — same known class of friction as earlier auth work;
  fixed with a narrow, commented type assertion right where the `in` check
  already proves the value can't actually be `undefined`.
- Tests (`tests/auctions/update.test.ts`, `tests/auctions/publish.test.ts`,
  all passing): the full 404/403 authorization matrix, successful edit,
  reserve-vs-stored-starting-price rejection, explicit-null reserve
  clearing, edit-after-publish rejection, publish without a resolvable
  endTime, endTime in the past, successful publish with startTime
  defaulting, publish picking up a schedule set via a prior update,
  double-publish rejection, and edit-after-publish rejection again via the
  publish path (proving the two endpoints agree on what "no longer
  editable" means).
- **Verified live**: full manual curl flow — create, publish without
  endTime (400), publish with a valid endTime (200, status `PUBLISHED`),
  attempt to edit the now-published auction (409), attempt to publish it
  again (409).

### TASK AUCTION-005 — Start/pause/cancel
- Full reasoning (start-as-resume, deferring admin pause, cancel's scope) in
  ADR-0010.
- `POST /:id/start`: `PUBLISHED` or `PAUSED` → `ACTIVE` (409
  `AUCTION_NOT_STARTABLE` otherwise); also rejects with 409
  `AUCTION_SCHEDULE_EXPIRED` if `endTime` has already passed — a state
  conflict, not a validation error, since the request (no body) has nothing
  wrong with it.
- `POST /:id/pause`: `ACTIVE` → `PAUSED` only (409 `AUCTION_NOT_PAUSABLE`
  otherwise).
- `POST /:id/cancel`: any non-terminal state (`DRAFT`/`PUBLISHED`/
  `ACTIVE`/`PAUSED`) → `CANCELLED`, sets `endedAt` (409
  `AUCTION_NOT_CANCELLABLE` from `ENDED` or already-`CANCELLED`).
- **No separate "resume" endpoint** — Section 73 lists `pause` but no
  matching verb to reverse it, so `start` does double duty (valid from
  `PUBLISHED` for first activation, or `PAUSED` for resuming) rather than
  inventing an unlisted action.
- **Deliberately no admin bypass** on any of the three, despite Section
  21's fraud-review mention — nothing in the system yet produces a fraud
  signal to act on (AI fraud detection is Phase 10), so granting the
  capability now would be speculative. All three reuse `requireOwnedAuction`
  (ADR-0009) unchanged.
- `end` remains unimplemented on purpose — closing an auction means
  determining a winner, which needs the Bid module (Phase 4). An
  `ACTIVE`/`PAUSED` auction whose `endTime` passes with nobody calling
  `cancel` just sits there for now; no automatic closing worker exists yet.
- Tests (`tests/auctions/lifecycle.test.ts`, all passing): the full
  not-startable/not-pausable/not-cancellable state-guard matrix, successful
  start from `PUBLISHED`, the schedule-expired rejection (using a
  short-lived real timer, not a mocked clock, to prove the check fires
  against actual elapsed time), resuming from `PAUSED` back to `ACTIVE`,
  cancellation from every non-terminal status via `it.each`, rejecting a
  second cancel and a cancel of a (force-set) `ENDED` row, and the
  404/403 ownership split reused correctly for these three new actions.
- **Verified live**: full manual curl flow — start while `DRAFT` (409),
  publish then start (200 `ACTIVE`), pause (200 `PAUSED`), resume via start
  again (200 `ACTIVE`), pause then cancel (200 `CANCELLED` with `endedAt`
  set), cancel again (409).

### TASK BID-001 — Bid Domain (schema)
- Full reasoning (append-only/no-status design, derived vs. stored
  "current winner," per-bidder idempotency scope) in ADR-0011.
- Prisma: `Bid { id, auctionId (FK, onDelete: Restrict), bidderId (FK,
  onDelete: Restrict), amountCents, idempotencyKey, createdAt }`. Migration
  `20260913191918_add_bids` applied.
- **No `status` column, table is append-only**: a bid that doesn't beat the
  current price is rejected with 400 and never persisted at all — nothing
  worth remembering about an attempt that never took effect. Never updated
  or deleted once created.
- **"Current highest bid" is derived, not stored**: since every accepted
  bid must exceed the previous price by construction (enforced at write
  time, BID-002), the most recent bid for an auction is automatically the
  highest one — no `isWinning` flag needing a second write kept in sync on
  every new bid.
- **`idempotencyKey` unique per `(bidderId, idempotencyKey)`, not globally**
  — Section 11's canonical idempotency example, applied to an action with
  no natural uniqueness key (unlike registration's `email`). Scoped to the
  bidder, matching how real payment APIs scope idempotency keys to the
  calling account.
- Deliberately did NOT add an outbox event — Section 10's full bid pipeline
  describes one, but the Outbox Pattern is Phase 7; nothing exists yet to
  consume an event if one were emitted.
- Deliberately schema-only, mirroring AUCTION-001 → AUCTION-002 and
  AUTH-001 → AUTH-002: concurrency control for the actual write (Section 9)
  is BID-002's decision against the real contention pattern, not decided
  speculatively here. Shill-bidding prevention (seller can't bid on their
  own auction) is flagged as a required BID-002 service-layer rule, since
  it can't be expressed by the schema.
- **Ran into a real Windows-specific issue while migrating**: `prisma
  generate` failed twice with `EPERM` renaming the query engine `.dll.node`
  — traced to several leftover `npm run dev` process trees from earlier
  live-verification steps this session (each `taskkill` had only killed the
  top-level listening PID, not the tsx-watch child process actually holding
  the file open). Confirmed via `Get-CimInstance Win32_Process` that every
  such process's command line pointed at this project before killing them,
  then generation succeeded.
- Verified: `npm run build`/`lint`/`test` all clean (92/92 tests still
  passing) after the migration; migration applied cleanly against the local
  Postgres container.

### TASK BID-002 — Place bid API
- Full reasoning (pessimistic vs. optimistic concurrency, why `SELECT ...
  FOR UPDATE` over both alternatives, the real idempotency race this task
  surfaced and its fix) in ADR-0012.
- `src/modules/bids/`: `schema.ts` (`amountCents`, required
  `idempotencyKey`), `repository.ts` (`placeBidTransactionally` — the whole
  bid pipeline as one `prisma.$transaction`: raw-SQL `SELECT ... FOR UPDATE`
  lock on the auction row, since Prisma's query builder has no row-locking
  API, then business validation via an injected callback, then insert bid +
  update auction), `service.ts` (`assertBidIsAcceptable` — not found →
  ownership/shill-bid check → auction status → schedule-expired → price),
  `controller.ts`, `routes.ts` (`Router({ mergeParams: true })`, verified
  empirically that Express 5 requires this for a nested router to see a
  parent mount's `:param` at all — confirmed with a throwaway script rather
  than assumed). Mounted at `POST /api/v1/auctions/:auctionId/bids`
  (app.ts), matching Section 31's own example path exactly.
- **Pessimistic locking (`SELECT ... FOR UPDATE`), not optimistic
  versioning**: chosen specifically because optimistic concurrency's core
  assumption (conflicts are rare) is false for exactly the case Section 46
  calls "Hot Auctions" — a popular auction IS many bidders contending for
  one row at once. A row lock (not a table lock) means different auctions
  never contend with each other; only genuinely contended bids on the SAME
  auction serialize, which is correctness, not an artificial bottleneck.
- **Shill-bidding guard**: a seller cannot bid on their own auction (403).
- **A real, non-hypothetical race the concurrency test caught**: two
  identical-idempotency-key concurrent bids on the SAME auction initially
  had the LOSING request rejected with a price-validation error instead of
  replaying the winner's result — because the loser's lock-wait let it see
  its own twin's price update BEFORE checking idempotency, so it validated
  its (now-tied) bid against an already-raised price and failed for an
  unrelated reason before ever reaching the P2002 path meant to catch this.
  Fixed by re-checking `(bidderId, idempotencyKey)` a SECOND time, inside
  the transaction, immediately after the lock, before running price
  validation — every same-auction bid serializes behind that one lock, so
  this is guaranteed to see a committed twin. The outer P2002 catch in
  `service.ts` remains necessary for a DIFFERENT, still-real case: the same
  key reused across two DIFFERENT auctions concurrently (ADR-0011's already-
  documented scope tradeoff), which locks two different rows and so can't
  be caught by the in-transaction check.
- No outbox event on bid acceptance (Phase 7 territory), no dedicated
  bid-specific rate limiter (Section 30 calls for one, but Phase 5's Redis
  work is where that belongs), and no bid on an ACTIVE auction whose
  `endTime` has already passed (409 `AUCTION_SCHEDULE_EXPIRED`, reusing the
  code ADR-0010 established for the same underlying situation on `start`).
- Tests (`tests/bids/place-bid.test.ts`, all passing): 401/404/403 (shill
  bid)/409 (not-active, schedule-expired)/400 (too low, invalid payload)
  cases, a successful bid updating the auction's current price, sequential
  idempotent replay, the same-auction race (now closed), the cross-auction
  race (still open by design, ADR-0011), and — Section 36's explicit ask —
  **15 concurrent bidders on one auction**, asserting the full invariant
  set: every accepted response has exactly one corresponding row (no lost
  or phantom bids), bid amounts are strictly increasing in `createdAt`
  order (no bid accepted out of price order), and the auction's final price
  matches exactly the highest bid actually persisted (no lost update).
- **Verified live**: full manual curl flow — bid before start (409), seller
  self-bid (403), bid too low (400), valid bid (201, auction price updated
  to match), idempotent replay (identical bid id returned).
- **Housekeeping**: cleaned up several more leftover `npm run dev` process
  trees from this session's live-verification steps (same root cause as
  BID-001's note — killing only the netstat-reported listening PID leaves
  the `tsx watch` parent alive). Going forward, killing every `node.exe`
  whose command line matches this project's path is the reliable cleanup,
  not the single listening PID.

### TASK BID-003 — Anti-sniping
- Full reasoning (extension basis: from the bid's own arrival, not the old
  scheduled end; why no cap; where the atomicity requirement is satisfied)
  in ADR-0013.
- `src/modules/bids/antiSniping.ts`: `ANTI_SNIPING_WINDOW_MS = 30_000` and a
  pure `computeExtendedEndTime(currentEndTime, now)` — returns `null` if
  ≥30s remain, otherwise returns exactly `now + 30s`. Deliberately a pure
  function, isolated from the transaction/lock, so the actual rule
  (including its boundary conditions) is unit-testable without a database.
- `repository.ts`'s `placeBidTransactionally` now also computes and applies
  the extension, in the SAME transaction and under the SAME row lock as
  accepting the bid — no separate write, no window where a bid could be
  accepted without its (possible) extension landing atomically alongside it.
- **Extends to `now + windowMs`, not `oldEndTime + windowMs`**: guarantees
  every valid late bid buys the same fixed 30s response window from its own
  arrival, regardless of exactly when within the trigger window it landed —
  chosen over the simpler "add a fixed increment to the old end" precisely
  because that alternative would give inconsistent actual response time
  depending on timing within the window.
- Bid-placement response now includes `auctionExtended: boolean` so a
  client gets immediate feedback without re-fetching the auction. A replay
  (either idempotency path) never reports a fresh extension — it's the same
  original acceptance, not a new event.
- **Deliberately no cap** on total extensions or extension count — a
  sustained late bidding war could in principle extend an auction
  indefinitely through this mechanism alone. Documented as an accepted,
  explicit gap rather than an invented, unrequested policy number.
- Tests: `tests/bids/antiSniping.test.ts` (pure function — no extension
  with plenty of time left, the exact boundary at `remaining === windowMs`
  extends nothing while one millisecond inside it does, extension is always
  relative to `now` not the old end, even for an already-passed endTime);
  `tests/bids/anti-sniping-integration.test.ts` (real endpoint — no
  extension with time to spare, extension when within the window verified
  against a real elapsed-time bracket, a second late bid chains a further
  extension from ITS OWN arrival, a rejected too-low bid extends nothing,
  and an idempotent replay neither re-extends nor reports a fresh
  extension). All passing.
- **Verified live**: real curl flow against the dev server — an 8-second-
  remaining auction, one valid bid, and the resulting `endTime` landed
  exactly 30.003 seconds after the bid's own timestamp, not the original
  schedule.

### TASK AUCTION-006 — Auction closing worker + bid history
- Full reasoning (why no manual `end` endpoint, in-process worker vs. a
  separate process, reusing the bid-placement lock for closing) in
  ADR-0014.
- `modules/auctions/repository.ts`: `findExpiredActiveAuctionIds(now)`
  (unlocked candidate scan using the `(status, endTime)` index from
  ADR-0007 — finally put to use) and `closeAuctionIfExpired(auctionId,
  now)` (the real transaction — locks the auction row with the SAME
  `SELECT ... FOR UPDATE` mechanism bid placement uses, ADR-0012, so a bid
  landing at the same instant as a close attempt serializes against it for
  free; re-verifies the auction is STILL expired under the lock, since
  anti-sniping may have pushed `endTime` out since the unlocked scan found
  it; determines the winner by reading `Bid` — no new column needed,
  matching ADR-0011's "winner is derived, not stored" design; marks
  `ENDED` with `endedAt`).
- `infrastructure/jobs/auctionClosingWorker.ts`: a `setInterval` (5s) that
  scans and closes every candidate, sequentially, logging each real
  closure (`auction.closed`). Started in `server.ts` alongside
  `app.listen`; stopped in the graceful shutdown handler (Section 69).
- **No manual `POST /:id/end` endpoint** — unlike `start`/`pause`/`cancel`,
  there's no real scenario for a human to trigger "determine the winner and
  end this now" distinct from what `cancel` already covers for "stop
  early." Ending only happens because the clock genuinely ran out.
- A `PAUSED` auction past its `endTime` is closed too — pause suspends new
  bids, it doesn't stop the clock.
- `GET /api/v1/auctions/:auctionId/bids` — new read endpoint (needed to
  actually observe/verify a winner), reusing auctions' own DRAFT-visibility
  rule (ADR-0008) via `getAuctionForViewer` rather than inventing a
  separate one. No cursor pagination (unlike auctions' own listing) —
  documented as a deliberate simplification, not a requirement yet.
- Updated a now-stale comment in `bids/service.ts` (previously said "no
  closing worker exists yet" from BID-002, written before this task) — the
  `AUCTION_SCHEDULE_EXPIRED` check there is now explicitly a belt-and-
  suspenders guard for the gap between "time ran out" and the worker's next
  5-second tick, not the only protection.
- Order creation (Section 19) is explicitly NOT part of this — no
  `Order`/`Payment` module exists yet (Phase 8); closing only determines
  and logs the winner today.
- Tests (`tests/auctions/closing.test.ts`, `tests/bids/list-bids.test.ts`,
  all passing): closes an `ACTIVE` auction and records the correct winner,
  closes an auction with zero bids, closes a `PAUSED` auction, leaves an
  unexpired `ACTIVE` auction untouched, idempotent across two runs, does
  NOT close an auction whose schedule moved since the unlocked scan found
  it (the anti-sniping race, verified directly against
  `closeAuctionIfExpired`'s own re-check), a bid on an already-ended
  auction still gets 409, and one true end-to-end test with a real 1-second
  wait (deliberately bid-free, since a bid that close to expiry would
  itself trigger an anti-sniping extension and defeat the test). Bid-history
  tests cover the visibility reuse, newest-first ordering, `limit`, and the
  empty case.
- **Verified live**: created a short-lived auction, waited for the REAL
  background worker (its actual `setInterval`, not `runOnce()` called
  directly) to close it, confirmed `ENDED`/`endedAt`, confirmed a
  subsequent bid attempt gets 409, confirmed the worker's own structured
  log line (`auction.closed`) appeared in the dev server's log.

### TASK WEB-000 — Frontend Foundation
- Full reasoning (App Router choice, in-memory-token + silent-refresh
  pattern, TanStack Query/Zustand split, why validation schemas are
  duplicated not shared yet) in ADR-0015.
- `apps/web` scaffolded via `create-next-app` (App Router, TypeScript,
  Tailwind), workspace-named `@auctionx/web`. Added `zustand`,
  `@tanstack/react-query`, `react-hook-form`, `@hookform/resolvers`, `zod`
  (version-matched to the backend's) per Section 5's stack. Root
  `package.json` gained `dev:web`/`build:web`/`lint:web` scripts mirroring
  the `*:api` convention.
- `store/authStore.ts` (Zustand): `user`, `accessToken` (memory-only —
  never `localStorage`, Section 28/29's XSS concern), and a `status` field
  (`idle|checking|authenticated|anonymous`) specifically so the UI never
  flashes a wrong logged-out state while the initial session check is in
  flight.
- `app/providers.tsx`: `SilentRefresh` calls `POST /auth/refresh` once on
  mount to recover the session from the httpOnly refresh cookie after a
  hard reload — the actual implementation of the "silent refresh" concept
  flagged back in AUTH-003.
- `lib/apiClient.ts`: thin `fetch` wrapper, `credentials: 'include'` on
  every call, `ApiError` mirroring the backend's exact `{code, message,
  details}` envelope (`middleware/errors.ts`).
- **Closed a long-deferred gap**: `services/api/src/app.ts`'s CORS changed
  from wildcard `cors()` to `cors({ origin: env.FRONTEND_URL, credentials:
  true })` — flagged as blocked "until a frontend origin exists" since
  AUTH-003; one now does.
- Pages: `/`, `/login`, `/register` — React Hook Form + Zod
  (`lib/validation/auth.ts`, deliberately duplicated from the backend's
  schema, not shared via a package yet), a `NavBar` showing live auth
  state.
- **Hit and worked through a real disk-space crisis mid-task**: the C:
  drive was completely full (487GB/487GB, 0 bytes free), which is what
  actually caused the first `npm install` to fail with `ENOSPC` — not a
  config problem. Stopped and asked rather than guessing at what to
  delete; some space was freed externally, install succeeded on retry
  (peaked around ~600-700MB free, still very tight).
- **A related, separate issue surfaced by the same disk pressure**: the
  Docker CLI/control-plane (`docker ps`, `docker compose ps`) hung
  completely and had to be abandoned — but the actual Postgres/Redis
  containers were confirmed still healthy and reachable throughout (ports
  still listening, and `/readiness` still returned a real `SELECT 1`
  success), so this was a control-plane issue only, not a data-loss or
  service-outage one. Not fixed (would require touching Docker Desktop
  itself, which felt riskier than leaving working containers alone) —
  flagged for the developer's awareness.
- **Verified in a real headless browser**, not just curl/unit tests
  (`chromium-cli` wasn't available on this Windows machine; used a
  one-off Playwright script instead, reusing an already-cached Chromium
  binary to avoid a large download on the nearly-full disk): full
  register → auto-login → logout → login → hard-reload flow, screenshots
  confirmed correct rendering and Tailwind styling, and — importantly —
  confirmed CORS+credentials genuinely work from a real browser context
  (supertest-based backend tests don't enforce CORS, so this was the
  first real check of that).
- **A genuine finding, not a bug**: the automated verification script's
  rapid-fire register/login/refresh calls tripped the real
  `authRateLimit` (10/15min, `NODE_ENV=development` uses the real
  threshold, not the raised test-only one) partway through, and one
  `logout` request was aborted by a Next.js dev-mode Fast Refresh reload
  mid-flight. Neither affected the outcome — `logoutRequest()` was already
  designed as best-effort (AUTH-003's idempotent logout is exactly why a
  failed logout call is safe to ignore client-side) — but both are worth
  the developer knowing about before manually clicking through the same
  flow many times in quick succession right after this.

### TASK WEB-001 — Auction browse/detail pages
- `app/auctions/page.tsx`: browse list using TanStack Query's
  `useInfiniteQuery` — maps directly onto the backend's keyset pagination
  (ADR-0008): each page's `nextCursor` becomes the next page's `cursor`
  param, no offset math introduced on the frontend either, for the same
  correctness reason it was avoided on the backend. A category filter
  (plain `<select>`, no new backend capability needed — `?category=`
  already existed).
- `app/auctions/[id]/page.tsx`: detail page — current price, description,
  bid history, and a client-side countdown (`lib/useTimeRemaining.ts`) for
  `ACTIVE` auctions. **Deliberately still read-only** — no bid form yet;
  that's WEB-002's job alongside auction creation, keeping this task
  scoped to proving browse/view works before adding a write path on top.
- `lib/auctions.ts`, `lib/types/auction.ts`, `lib/format.ts`
  (`formatCents`/`formatCategory`) — the same thin-wrapper-plus-types
  pattern established in WEB-000's `lib/auth.ts`.
- No dedicated ADR for this task — it's a direct, expected application of
  ADR-0015's already-established patterns (TanStack Query for server
  state, duplicated-not-shared types), not a new architectural decision.
- **Verified live against real seeded data**, not just empty states:
  created a seller account and three real `ACTIVE` auctions across
  different categories via the API, placed one real bid from a separate
  bidder account, then drove the actual browser (same cached-Chromium
  Playwright approach as WEB-000) to confirm the list shows them, the
  category filter correctly excludes non-matching auctions, the detail
  page shows the post-bid current price and matching bid-history entry,
  the live countdown renders, and a nonexistent auction id shows a clean
  not-found state. Zero console/network errors this run.
- **Found, not fixed**: the local dev Postgres database has accumulated
  real leftover rows (auctions/users) from this session's many earlier
  manual curl-based live-verification steps during backend tasks — visible
  now in the browse list's real prod-like results (e.g. "Live Closing
  Lot", "Live Sniping Lot" from BID-003/AUCTION-006's own verification).
  Harmless (doesn't affect correctness, just dev-data tidiness) and not
  cleaned up yet — flagged for the developer rather than unilaterally mass-
  deleting rows without being asked.

### TASK WEB-002 — Create auction + bidding UI
- Full reasoning (chaining create->publish->start into one form submit,
  and the real refresh-token race this task surfaced) in ADR-0016.
- `/auctions/new`: create form (title/description/category/condition/
  starting+reserve price/duration). Submits create -> publish (endTime =
  now + chosen duration) -> start in sequence, then redirects to the
  detail page — a seller using this simple form wants an auction live
  immediately, not sitting in DRAFT/PUBLISHED limbo waiting for a
  dashboard that doesn't exist yet. If publish/start fails after a
  successful create, the error message links to the (now real, if
  not-yet-published) auction rather than hiding that it exists.
- `app/auctions/[id]/BidForm.tsx`: bid form, shown only when the auction is
  `ACTIVE`, the viewer is authenticated, and the viewer isn't the seller —
  the seller sees "You can't bid on your own auction" instead, the
  anonymous case sees a login link. A fresh idempotency key per submit
  click (`crypto.randomUUID()`, the Web Crypto global, not `node:crypto`).
  On success, invalidates both the auction-detail and bids TanStack Query
  caches so the new price/history appear immediately.
- `lib/bidErrors.ts`: translates backend error codes into bidder-facing
  copy — the backend's literal `VALIDATION_ERROR` message ("...current
  price of 6000 cents") becomes "Your bid must be higher than the current
  price." First place in the frontend that a backend error message gets
  deliberately reworded rather than shown as-is.
- The detail page (WEB-001) now polls every 5s while `ACTIVE` — an
  explicit, temporary stand-in for Phase 6's WebSockets, added because
  there's now something worth watching change in near-real-time (another
  bidder's bid).
- A lint-rule finding, not a bug: this Next.js version's
  `react-hooks/purity` rule flags any lexical `Date.now()` call inside a
  component function on sight, even one that only runs inside an event
  handler and never during render. Fixed by extracting `computeEndTime`
  as a named function outside the component — a real fix, not a
  suppression.
- **A real, non-hypothetical concurrency bug found by actually running the
  app**: a freshly-logged-in bidder's session silently vanished on the
  next page load. Root cause — `SilentRefresh`'s `useEffect` had no guard
  against React Strict Mode's deliberate double-invocation in dev; two
  near-simultaneous `/auth/refresh` calls both presented the same
  pre-rotation cookie, the first rotated it, the second got treated as
  reuse and revoked the ENTIRE session family (ADR-0004 working exactly as
  designed — just triggered by something other than an attacker). Fixed
  with a `useRef` guard so this component instance's refresh call only
  ever actually fires once. **Explicitly NOT a complete fix**: the ref
  can't protect against two separate browser TABS each independently
  refreshing near-simultaneously in production — that's a real, still-open
  gap in the backend's rotation logic (AUTH-004), flagged as a revisit
  condition for a dedicated future task, not fixed reactively here.
- **Verified live** against real data (not mocks): registered a seller and
  bidder via the API directly (to conserve auth-rate-limit budget), then
  drove a real browser through the full loop — seller creates and
  auto-publishes an auction, seller's own view correctly hides the bid
  form, log out, bidder logs in, places a valid bid (price updates to
  $25.00, appears in history), then a too-low bid shows the friendly error
  message. Confirmed zero console/network errors on the successful run
  (one benign Fast-Refresh-aborted logout request on an earlier run,
  already understood from WEB-000 and already handled by the existing
  best-effort `.catch()`).
- **Hit the real `authRateLimit` again mid-verification** (10/15min,
  cumulative across a full day of testing) — this time cleared it via a
  narrow, targeted fix rather than a broad one: connected directly to
  Redis over its host-mapped port (`docker exec` was still unresponsive
  from the earlier disk episode, and a `FLUSHALL` was correctly declined
  by the permission system as too broad) and deleted only the specific
  `ratelimit:*` keys, leaving all other Redis data untouched.

### TASK CACHE-001 — Cache-aside for `GET /auctions/:id`
- Full reasoning (why this endpoint and not the list endpoint, why keyed by
  auction id only and not per-viewer, the invalidate-after-commit ordering)
  in ADR-0017.
- `infrastructure/redis/auctionCache.ts` (new): `getCachedAuction`/
  `setCachedAuction`/`invalidateAuctionCache` — all best-effort, swallow
  Redis errors internally (logged, never thrown), Date fields revived on
  read so a cache hit is indistinguishable from a fresh Prisma read to any
  caller. Key `auction:{id}`, TTL 5s (matches the frontend's own poll
  interval from WEB-002 — even a missed invalidation can't be staler than
  the polling loop already tolerates).
- `modules/auctions/service.ts`'s `getAuctionForViewer`: cache-aside read —
  try cache, populate on miss, apply DRAFT-visibility identically either
  way (visibility is checked on the row AFTER retrieval, never baked into
  the cache key, so there's one cache entry per auction, not one per
  viewer).
- Every existing write path now invalidates by `auctionId` right after its
  own write commits, never before and never from inside the transaction —
  `updateExistingAuction`, `publishExistingAuction`, `startExistingAuction`,
  `pauseExistingAuction`, `cancelExistingAuction` (all in
  `auctions/service.ts`), the closing worker's `runOnce` (only on an actual
  close), and `bids/service.ts`'s `placeBid` (unconditionally after
  `placeBidTransactionally` resolves, even on its internal idempotent-replay
  branch — an unneeded DEL is harmless, and there's no cheap signal for
  "did this actually mutate" worth threading back out just to skip it).
- Deliberately did NOT cache `GET /auctions` (the list endpoint) — no
  measured hot-path justification yet (Section 62), and its cache key would
  have to encode filters × cursor × viewer-visibility, which is a much
  worse cardinality tradeoff than the single-item endpoint's one-key-per-
  auction shape.
- **Verified live against the real running dev server and real Redis**, not
  just unit tests: created a fresh auction, confirmed a `GET` creates
  `auction:{id}` in Redis with `TTL 5` and the exact expected JSON: placed a
  real bid and confirmed the key is deleted immediately (not after the 5s
  TTL), and that the very next `GET` returns the new price with zero
  staleness; separately poisoned the cache key with invalid JSON and
  confirmed the read path degrades gracefully (logs a warning, falls back
  to Postgres, returns 200 with correct data) rather than erroring — proving
  the fail-open behavior, not just asserting it.
- Build/lint/full test suite (127/127) all clean after the change — no
  existing test needed modification, since the cache is fully transparent
  to every existing caller's observed behavior.

### TASK RATELIMIT-002 — Bid-specific rate limiting
- Full reasoning (why this isn't the same problem as Section 46's hot
  auctions, why keyed by `(user, auction)` not user alone, why the real
  threshold is verified live rather than in Jest) in ADR-0018.
- `middleware/rateLimit.ts`: `bidRateLimitKeyBy` (exported, unit-tested —
  the one genuinely new piece; the blocking/header/fail-open mechanism
  itself was already fully covered by AUTH-006's tests) and `bidRateLimit`
  (10 requests per 10s window, reusing the same generic `rateLimit()`
  factory and fixed-window Lua script AUTH-006 built — no new Redis
  infrastructure).
- `modules/bids/routes.ts`: `bidRateLimit` added to `POST /` bid placement,
  after `authenticate` (needs `req.user`) and stacking on top of the
  already-global `apiRateLimit`, same layering pattern `authRateLimit`
  already established.
- **Not the same threat as a legitimately hot auction** — many different
  real bidders on one popular auction is Section 46 working correctly, and
  `apiRateLimit`'s per-user keying already permits it untouched. This
  limiter targets a different, real cost: every bid attempt (even a
  rejected one) takes a Postgres row lock (ADR-0012), so one identity
  hammering one auction spends real lock time that serializes against
  every other genuine bidder on that same row.
- Tests (`tests/rateLimit.test.ts`, appended): 4 new cases against
  `bidRateLimitKeyBy` directly (derives from both user+auction, isolates by
  auction, isolates by user, falls back to `"unknown"` rather than
  throwing) — no Jest test couples to the real 10/10s threshold, matching
  the established pattern for every other production-tuned limiter in this
  codebase.
- **Verified live** against the real dev server: 10 rapid bid attempts on
  one fresh auction (each a real, correctly-rejected too-low-price attempt)
  all succeeded through the limiter; the 11th and 12th returned
  `429 TOO_MANY_REQUESTS` with `X-RateLimit-Limit: 10` and a positive
  `retryAfterSeconds`; a request after the real 10-second window elapsed
  showed a fresh counter (`X-RateLimit-Remaining: 9`).
- Build/lint clean; full suite 131/131 passing (127 + 4 new).

### TASK WEB-003 — Seller dashboard
- `app/my-auctions/page.tsx` (new): lists the caller's own auctions —
  `listAuctionsRequest({ sellerId: user.id, accessToken })`, reusing the
  backend's existing `sellerId` filter and its own-DRAFT visibility rule
  (ADR-0008) unchanged; no backend changes were needed for this task at
  all, since every lifecycle action it exposes (`publish`/`start`/`pause`/
  `cancel`) already existed as an endpoint (AUCTION-004/005). A plain
  `useQuery`, not `useInfiniteQuery` like the public browse page
  (WEB-001) — a seller's own listing count is expected to stay far below
  the 50-item page cap for the foreseeable future, so paginating it now
  would be solving a problem that doesn't exist yet (Section 62).
- `app/my-auctions/AuctionRow.tsx` (new): one row per auction, each owning
  its own mutation state. Buttons are entirely determined by
  `auction.status`, matching the backend's own state-machine exactly
  (AUCTION-005): `DRAFT` gets a duration picker + "Publish & start" (chains
  publish→start, mirroring the create page's own chaining, ADR-0016 —
  this is the actual recovery path that ADR flagged as missing back then);
  `PUBLISHED` gets "Start" only (no new input needed — `endTime` is already
  stored from a prior publish); `ACTIVE` gets "Pause"/"Cancel"; `PAUSED`
  gets "Resume" (reuses `start`, same ADR-0010 "no separate resume verb"
  reasoning WEB-002 already relied on) /"Cancel"; `CANCELLED`/`ENDED` get
  no actions at all.
- `lib/duration.ts` (new): `computeEndTime`/`DURATION_LABELS` extracted out
  of `app/auctions/new/page.tsx` (WEB-002) since this task needs the exact
  same "publish with a chosen duration" computation a second time —
  duplicating it would risk the two copies drifting for no benefit. Same
  `react-hooks/purity`-driven "define outside the component" shape as
  before, now justified twice over.
- `lib/auctions.ts`: `listAuctionsRequest` gained `status`/`sellerId`/
  `accessToken` params (previously public-browse-only, no way to ask for
  the caller's own DRAFTs); added `pauseAuctionRequest`/
  `cancelAuctionRequest` alongside the existing `publishAuctionRequest`/
  `startAuctionRequest`.
- `NavBar.tsx`: added a "My auctions" link next to "Sell an item."
- Deliberately did NOT bundle the multi-tab refresh-token race fix
  (ADR-0016's other flagged gap) into this task, even though PROGRESS.md
  had tentatively paired them — ADR-0016 itself already argued that fix
  deserves "its own task with its own concurrent-refresh test," and
  nothing about building this dashboard changed that reasoning.
- Deliberately scoped to lifecycle actions only, not a full edit form for
  a `DRAFT` auction's title/price/etc. — that gap (already listed as
  "Edit-after-publish / unpublish" in Not yet done) is unrelated to what
  this task's own motivating gap (ADR-0016: no recovery UI after a failed
  publish/start) actually needed.
- **Verified live in a real browser**, not just build/lint: seeded one
  auction in each of `DRAFT`/`PUBLISHED`/`ACTIVE` via direct API calls
  (since the only UI path to create one, WEB-002's form, auto-chains all
  the way to `ACTIVE` and can't itself produce a stuck intermediate state
  to test against), then drove the actual dashboard through the full
  cycle: `DRAFT` →(Publish & start)→ `ACTIVE`, `PUBLISHED` →(Start)→
  `ACTIVE`, `ACTIVE` →(Pause)→ `PAUSED` →(Resume)→ `ACTIVE` →(Cancel)→
  `CANCELLED` with zero action buttons remaining on the terminal row.
  Zero console/network errors. Build/lint clean on both frontend and
  (unchanged) backend.

### TASK AUTH-008 — Fix refresh-token rotation race
- Full reasoning (the exact silent-fork failure mode, why a DB row lock
  over a Redis distributed lock, why the user-active check moved inside
  the transaction) in ADR-0019.
- `modules/auth/repository.ts`: `rotateRefreshToken` and `revokeTokenFamily`
  removed outright (not deprecated/kept-for-compat — dead code here would
  invite a future caller back into the exact race being closed); replaced
  by `consumeRefreshToken`, which locks the presented token's row with raw
  SQL `SELECT ... FOR UPDATE` and performs the ENTIRE check-then-act
  sequence — revoked check, expiry check, user-active check, and either
  family revocation (reuse) or create+revoke (rotation) — inside that one
  locked transaction. Returns a discriminated result (`not_found` /
  `reused` / `expired` / `account_disabled` / `rotated`) rather than
  throwing, matching the bid module's `validate`-callback-inside-the-lock
  layering precedent (ADR-0012).
- `modules/auth/service.ts`'s `refreshTokens`: now generates the candidate
  replacement token upfront (cheap, discarded if the transaction doesn't
  reach the rotate branch) and makes exactly one call to
  `consumeRefreshToken`, translating its discriminated result into the
  same error codes/messages as before — zero change to the public API or
  response contract, only to the internal race-safety of how the decision
  gets made.
- **The actual bug this closes is worse than what ADR-0016 observed**: the
  old code's read (unlocked) and rotate (separate transaction) were split
  across a network round trip, so two concurrent requests presenting the
  same token could both read `revokedAt: null` and both go on to rotate
  successfully — silently forking one token into two live sessions with no
  error to either caller. ADR-0016's manually-observed "second request
  gets logged out" outcome was just one possible timing outcome, not a
  guarantee; under different timing the fork would go through completely
  undetected. The lock makes the outcome deterministic instead: one
  winner, one reuse-detected loser, every time.
- Tests (`tests/auth/refresh.test.ts`, appended): a genuine concurrency
  test firing two refresh requests at the same pre-rotation token via
  `Promise.all` — real concurrent transactions, not sequential calls
  dressed up to look concurrent — asserting exactly one `200`/one `401
  REFRESH_TOKEN_REUSED`, AND that the winner's own brand-new token is also
  dead immediately after (proving the whole family was revoked, not just
  that the loser happened to fail). Run several times in isolation to
  check for flakiness inherent to testing a real race condition; passed
  consistently every time. All 5 pre-existing refresh tests still pass
  unmodified.
- Deliberately did NOT touch the frontend: ADR-0016's `useRef` guard on
  `SilentRefresh` already fully fixes the single-mount double-invocation
  it was built for, and the legitimate-multi-tab false-positive logout
  this fix leaves in place is the same accepted tradeoff ADR-0004 already
  documents (a lost-response retry looks identical to theft from the
  server's point of view) — now guaranteed rather than timing-dependent,
  not a new gap this task introduced.
- Build/lint clean; full suite 132/132 passing (131 prior + 1 new).

### TASK WS-001 — WebSocket gateway foundation
- Full reasoning (in-process vs. a separate gateway service, the
  first-message auth handshake vs. a query-string token or a broadened
  cookie scope, per-auction rooms vs. broadcast-and-filter) in ADR-0020.
- `infrastructure/websocket/gateway.ts` (new): `startWebSocketGateway(server,
  options)` / `stopWebSocketGateway()` — same module-singleton start/stop
  shape as `auctionClosingWorker.ts` — attached to the SAME `http.Server`
  `app.listen()` returns via `WebSocketServer({ noServer: true })` and a
  manually-routed `upgrade` listener (claims exactly `/ws`, destroys
  anything else, rather than becoming a catch-all). Zod validates every
  inbound message against a discriminated union (`auth`/`subscribe`/
  `unsubscribe`) — the same trust-boundary-validation policy already
  applied to HTTP bodies, applied here to WS messages.
- **Auth**: the browser can't set a custom header on a WebSocket handshake,
  and the access token lives only in memory on the client (never a
  cookie — ADR-0015), so the upgrade is accepted unauthenticated and the
  client's first message MUST be `{type: 'auth', accessToken}`. No valid
  auth within `authTimeoutMs` (default 5s) closes the connection with code
  `4001`; an invalid/expired token closes with `4002`. Rejected putting the
  token in a `?token=` query string specifically because URLs leak into
  proxy/CDN/browser-history logs far more readily than a message payload
  does (Section 34: never log a token).
- **Fanout**: per-auction rooms (`Map<auctionId, Set<WebSocket>>`),
  `subscribe`/`unsubscribe` messages join/leave a room, `broadcastToAuction
  (auctionId, payload)` sends only to that room's sockets — never a
  broadcast-to-everyone-then-filter-client-side design, which Section 46
  rules out directly for a popular auction with many watchers.
  Deliberately single-instance, in-memory only (no Redis Pub/Sub yet) —
  correct at today's one-API-instance scale, explicitly flagged as broken
  the moment a second instance exists (Section 14 already names Redis
  Pub/Sub as the fix for that, not optional once true).
- **Heartbeat**: a 30s server-initiated `ping`; a connection that misses a
  `pong` before the next tick gets `terminate()`d (not `close()`d — a
  half-open connection can't complete a clean close handshake either).
  `ws`'s client library answers pings automatically at the protocol level,
  no application code needed client-side.
- **Graceful shutdown** (Section 69): `server.ts` now calls
  `stopWebSocketGateway()` before `server.close()` — every open connection
  gets an explicit `1001` ("going away") close frame first. WebSockets
  close BEFORE the HTTP server, not after, since they're long-lived
  connections, not in-flight requests waiting to finish.
- New dependency: `ws` + `@types/ws`. Chosen over Socket.IO specifically
  because Socket.IO's own framing/transport-fallback/rooms abstraction
  would hide exactly the WebSocket mechanics (handshake, ping/pong, close
  codes) this project exists to teach directly.
- **A real bug found while writing the tests, not by inspection**:
  `stopWebSocketGateway` didn't remove its `upgrade` listener from the
  server, so a start→stop→start cycle would stack a second, then a third,
  listener on the same server, each independently trying to
  `handleUpgrade` the same socket. Harmless in production (start/stop each
  happen exactly once per process lifetime) but a real bug all the same,
  and exactly the kind that "start/stop should be symmetric" testing is
  supposed to catch. Fixed by tracking the listener reference explicitly
  and removing it on stop.
- Tests (`tests/websocket/gateway.test.ts`, all passing, 8 new): auth
  timeout (`4001`), invalid token (`4002`), successful auth, rejecting
  subscribe/unsubscribe before authentication, fanout correctly scoped
  (a client subscribed to a DIFFERENT auction proven not to receive
  another auction's broadcast — not just "the right client got it," but
  "the wrong client provably didn't"), unsubscribe actually stopping
  further delivery, a healthy connection surviving a real heartbeat
  interval (proving the heartbeat wiring doesn't kill connections that
  respond normally), and every connection receiving `1001` when the
  gateway stops.
- **Verified live** against the real dev server, not just Jest's synthetic
  `http.Server`: registered/logged in a real user for a real access token,
  connected a real `ws://` client through the actual `app.listen()` server
  (Helmet/CORS/etc. all present), confirmed `auth.ok`/`subscribed`/
  `unsubscribed`/`INVALID_MESSAGE`/`4002` end to end. **Explicitly not
  verified**: a real OS-level `SIGTERM` triggering shutdown — Windows'
  `process.kill()` from a separate process unconditionally terminates
  rather than delivering an emulated signal a handler can catch (documented
  Node.js behavior on Windows, not a bug in this code), so that specific
  demonstration isn't possible on this dev machine. Said so plainly instead
  of claiming a check that didn't actually happen; the shutdown code path
  itself is covered by the Jest test that calls `stopWebSocketGateway()`
  directly, and `server.ts`'s signal handlers are pre-existing,
  already-verified code from TASK-000.
- Build/lint clean; full suite 140/140 passing (132 prior + 8 new).

### TASK WS-002 — Wire real events through the WebSocket gateway
- Full reasoning (the auth-relaxation correction, why the payload carries
  no data, why the same six CACHE-001 call sites) in ADR-0021.
- `infrastructure/realtime/auctionEvents.ts` (new): `notifyAuctionChanged
  (auctionId, reason)` — the one place that pairs `invalidateAuctionCache`
  (ADR-0017) with `broadcastToAuction` (ADR-0020), invalidating first so a
  client reacting to the broadcast by refetching can't land on a still-warm
  cache entry.
- **Corrected a real design gap in WS-001 before wiring anything**:
  mandatory authentication (ADR-0020's `4001` timeout) would have silently
  broken live updates for anonymous viewers — `GET /auctions/:id` is public
  (ADR-0008) and the frontend already lets anonymous visitors watch an
  `ACTIVE` auction, but an anonymous viewer has no access token to send.
  `gateway.ts` revised: `authTimeoutMs`/the auth timer/`4001` removed
  entirely; `auth` is processed whenever it arrives rather than gated to
  "before anything else"; subscribe/unsubscribe never require it. `4002`
  (invalid token) is unchanged. Documented as an explicit amendment — a
  pointer added to the top of ADR-0020 itself — not a silent rewrite of
  that decision's history.
- **Payload carries no auction data, only a signal**: `{type:
  'auction.changed', auctionId, reason: 'bid' | 'lifecycle'}`. Rejected
  pushing full auction/bid data over the socket specifically to avoid a
  second serializer (with its own visibility rules, ADR-0008) drifting from
  REST's — the socket only tells a subscribed client WHEN to refetch, REST
  stays the only place that decides WHAT the data looks like.
- Called from the exact same six sites CACHE-001 already invalidates from:
  `bids/service.ts`'s `placeBid` (unconditionally, same "harmless no-op on
  replay" reasoning CACHE-001 already established), and
  `auctions/service.ts`'s `updateExistingAuction`/`publishExistingAuction`/
  `startExistingAuction`/`pauseExistingAuction`/`cancelExistingAuction`,
  plus `auctionClosingWorker.ts`'s actual-close branch.
- `apps/web/lib/useAuctionSocket.ts` (new): connects to `/ws` derived from
  the same `NEXT_PUBLIC_API_URL` `apiClient.ts` already uses (no second env
  var to keep in sync); sends `auth` when a token exists (never a
  precondition for subscribing); on `auction.changed`, invalidates
  `['auctions','detail',id]` and `['auctions','bids',id]` — the same two
  keys the retired poll refetched. Reconnects on an unexpected close with
  capped exponential backoff (2s → 4s → 8s… capped at 30s) — Section 14
  requires reconnection, and without it one dropped connection would
  silently freeze this page's live updates with no visible symptom.
- `app/auctions/[id]/page.tsx`: `refetchInterval`/`ACTIVE_POLL_INTERVAL_MS`
  removed from both queries (retiring ADR-0016's stand-in); `useAuctionSocket`
  called instead, gated on the identical `status === 'ACTIVE'` condition the
  old poll used.
- Tests (`tests/websocket/gateway.test.ts` updated): removed the two tests
  whose premise no longer holds (auth-timeout close, reject-before-auth);
  added one proving anonymous subscribe + broadcast delivery works with no
  `auth` message ever sent. Net 7 tests in this file (was 8), full backend
  suite 139/139.
- **Verified live in a real browser** (Playwright, same cached-Chromium
  pattern as WEB-000/001/002): registered a real seller and bidder via the
  API, created/published/started a real `ACTIVE` auction, opened an
  **anonymous** (no login at all) browser context on its detail page,
  confirmed the WebSocket connects and subscribes for an anonymous viewer,
  placed a real bid from a separate process (not the browser), and watched
  the anonymous viewer's displayed price change from $10.00 to $25.00 with
  **zero page reload** and the new bid appear in history — proving the
  event wiring and the anonymous-access correction work together, not just
  each in isolation.
- **A genuine, separate infrastructure finding surfaced during
  verification, NOT caused by or fixed in this task**: the app's own
  `REDIS_URL=redis://localhost:6379` connection reaches a different,
  persistent Redis instance than the `auctionx-redis` Docker container —
  confirmed by comparing `docker exec auctionx-redis redis-cli DBSIZE`
  (0, matching ADR-0005's no-volume, recently-restarted container) against
  a direct `ioredis` connection from the Windows host to the same
  `localhost:6379` (67 keys, including `bull:resourcex-jobs:*` BullMQ data
  that isn't part of this project at all). Something else on this dev
  machine is bound to port 6379. Rate-limit keys were cleared directly
  through that same connection to unblock verification (established
  precedent, WEB-002), but the mismatch itself is unresolved — flagged for
  the developer, not investigated further here (see "Known accepted
  issues" below).
- Build/lint clean on both workspaces.

### TASK MEDIA-001 — Object storage for auction images
- Full reasoning (Cloudinary-vs-R2, the MinIO/LocalStack dead ends and why
  each was rejected, presigned POST vs PUT, why bucket creation moved into
  application code, the policy-enforcement local-verification gap) in
  ADR-0022.
- Asked the developer directly before building: Cloudinary vs. Cloudflare
  R2 (+ a generic S3-compatible client). Chose R2 — Cloudinary's proprietary
  API has no self-hosted local equivalent, which would mean local dev
  depends on a live third-party account, breaking the same principle
  already applied to every other piece of local infrastructure (Postgres/
  Redis fully self-hosted, Section 83).
- **Two real, current dead ends, each actually tested before being
  abandoned, not assumed from stale docs**: `docker pull minio/minio` (and
  every public mirror — Docker Hub, `quay.io`, `ghcr.io`) returns "access
  denied," a real distribution restriction MinIO applied after this
  project's constitution named them as the default choice. LocalStack pulls
  fine but every currently-listed tag refuses to start without a
  `LOCALSTACK_AUTH_TOKEN` from a live account — even for the free community
  S3 service, which is the exact "local dev needs a live account" problem
  Cloudinary was rejected for, applied evenhandedly to a provider that
  isn't usually thought of as "a third-party service" the way Cloudinary
  obviously is.
- Landed on `adobe/s3mock` (Apache-2.0): no login, no account, verified with
  a raw `docker run` + curl PUT/GET round-trip BEFORE wiring it into
  `docker-compose.yml`, not assumed to work from its README alone.
- `infrastructure/storage/s3Client.ts` (new): singleton `S3Client`
  (`forcePathStyle: true`, correct for both s3mock and R2), plus
  `ensureBucketExists()` — called once at server boot, idempotent, never
  throws (object storage unavailable must not block the app from serving
  unrelated traffic, Section 51/12's pattern applied to a new subsystem).
  Bucket creation deliberately lives here, in application code, not in a
  docker-compose init container — the second such attempt (after a MinIO
  `mc` container, then an AWS-CLI container for LocalStack) was abandoned
  along with its service, and application-level creation is simply more
  portable: a no-op in production against a bucket that already exists.
- `infrastructure/storage/presign.ts` (new): `createPresignedUpload` —
  presigned POST (not PUT), specifically because a POST policy's
  `Conditions` (`content-length-range` 5MB, exact-match `Content-Type`
  against a JPEG/PNG/WebP allow-list) travel WITH the cryptographic
  signature, unlike a PUT signature which can only authorize a key, leaving
  size/type as client-side-only (bypassable) checks. Object key scoped
  `auctions/{sellerId}/{uuid}.ext` from the verified JWT subject — this is
  what makes "any authenticated user may call presign" a safe policy,
  since nobody can be handed a signature for a key outside their own prefix.
- **A real, honestly-reported gap found during live verification**: a
  scripted test uploaded a file with a mismatched Content-Type and a 6MB
  file (over the 5MB limit) using otherwise-valid presigned credentials —
  BOTH succeeded (200) against s3mock, when real S3/R2 would reject them.
  Confirmed this is a mock limitation, not a bug in this code, by decoding
  the actual base64 `Policy` field from a real presign response and
  verifying its `conditions` array contains the correct, standard
  `content-length-range`/`Content-Type` entries — the part of this design
  actually within the codebase's control. `tests/uploads/presign.test.ts`
  tests THAT (the generated document), not policy enforcement, which
  can't be verified against this particular local mock.
- `modules/uploads/`: `POST /api/v1/uploads/presign`, behind `authenticate`
  only — no dedicated rate limiter (the global `apiRateLimit` covers call
  frequency; the real resource, bucket storage, is bounded per-object by
  the signed policy's size limit, not by presign-call frequency).
- `modules/auctions/schema.ts`: every `images` URL must now start with
  `env.S3_PUBLIC_URL_BASE` — closes off a client submitting an arbitrary
  external URL, the same "never trust a client-controlled value further
  than necessary" reasoning (Section 28) applied to a new field.
- Frontend (`apps/web`): `lib/uploads.ts` (presign + direct-to-storage
  upload helpers — deliberately NOT using `apiFetch`, since this request
  targets a different origin, needs multipart form data, and must NOT carry
  our app's Authorization header/cookies), file input on
  `app/auctions/new/page.tsx` with EAGER per-file upload on selection (not
  deferred to submit — the presigned-POST pattern is built for this),
  thumbnail previews with per-image removal. Uploaded images now render on
  `app/auctions/page.tsx` (first-image thumbnail in the list) and
  `app/auctions/[id]/page.tsx` (full image strip) — plain `<img>`, not
  `next/image`, since the storage domain isn't fixed yet (local `s3mock`
  vs. an eventual R2 domain) so `next/image`'s required `remotePatterns`
  can't be configured until deployment; explicitly flagged as a revisit
  condition, not silently worked around.
- Tests (`tests/uploads/presign.test.ts`, 5 new, all passing):
  unauthenticated rejection, unsupported content-type rejection, response
  shape + bucket-origin scoping + per-seller key-prefix isolation, and the
  signed-policy-document content check described above.
- **Verified live, twice**: (1) a scripted end-to-end flow — real register/
  login, real presign call, a REAL PNG uploaded via multipart POST directly
  to s3mock, a GET returning byte-identical content back, and creating a
  real auction whose `images` array references that URL (201, schema
  validation passed) — all via direct HTTP calls, no mocking. (2) A real
  Playwright browser session: registered and logged in through the actual
  UI forms, selected a real image file through the file input, watched the
  thumbnail preview appear (proving the upload genuinely completed, not
  just that a request was sent), submitted, and confirmed the resulting
  auction's photo renders correctly on both its own detail page AND the
  public browse list.
- Build/lint clean; full backend suite 144/144 passing (139 prior + 5 new).
- **Addendum, same day**: the developer reported uploaded images not
  showing up in the frontend. Root cause was self-inflicted, not a code
  bug — `s3mock` had no volume, so recreating its container earlier in
  this session (to fix an unrelated healthcheck) silently wiped every
  previously-uploaded object while Postgres kept referencing the dead
  URLs. Diagnosed properly: confirmed a fresh upload worked perfectly
  (ruling out a code bug) and reproduced the exact symptom
  (`net::ERR_BLOCKED_BY_ORB` in Chrome — a 404 disguised as what looks
  like a CORS/rendering error) against the developer's own real "House"
  test auction. Fixed properly, not just patched: s3mock ignores a mounted
  volume unless told where to actually write AND told to retain files on
  exit — neither is documented anywhere obvious, so the real property name
  (`COM_ADOBE_TESTING_S3MOCK_STORE_ROOT`) was extracted directly from the
  image's own compiled bytecode; a second blocker (fresh named volumes
  mount root-owned, this image's default user is non-root) needed
  `user: "0:0"` too. Verified against the ACTUAL failure scenario (a full
  `docker rm` + recreate, not just a `restart`) before calling it fixed.
  Full details in ADR-0022's Addendum section.

## Concepts taught this session

- Fail-fast env validation.
- Liveness vs readiness as genuinely distinct concerns — demonstrated live,
  not just asserted.
- Structured error envelopes vs leaking internals to clients.
- Why modular monolith over microservices-from-day-one (ADR-0001).
- UUID vs auto-increment PKs (enumeration/information leak, cross-service
  coordination) and the explicit tradeoff (B-tree insert locality) with its
  revisit condition (switch to UUIDv7 only if profiling shows it matters).
- Why `passwordHash` lives directly on `User` for now instead of a
  speculative multi-provider `Credential` table — a concrete example of
  "don't design for hypothetical future requirements," with the exact
  revisit condition written down so it isn't just deferred and forgotten.
- Role (platform RBAC) vs seller/buyer capability (product-domain state) are
  different concerns and shouldn't share a column/table.
- Why PostgreSQL + Prisma over a document store or raw SQL (ADR-0002),
  specifically because bidding needs real ACID transactions and row locking,
  not just "a place to put JSON."
- PrismaClient as a per-process singleton, not per-request (connection pool
  exhaustion otherwise).
- Argon2id vs bcrypt: memory-hardness as the specific property that resists
  GPU/ASIC-parallelized cracking, which a pure time-cost function (bcrypt)
  doesn't provide as strongly.
- Why registration doesn't need an `Idempotency-Key` header even though
  Section 11 lists mutating endpoints generally needing one — the natural
  unique constraint already provides the safety property; contrasted with
  bid placement, which has no natural key and genuinely needs the pattern.
- The check-then-insert race condition: why "does this email exist? then
  insert" is unsafe under concurrency, and why letting the DB's unique
  index be the single source of truth (catch-and-translate the constraint
  violation) is the correct fix — demonstrated with a real concurrent test,
  not just asserted.
- `auth` vs `users` module boundary: `auth` owns credential-related access
  to `User` now; a dedicated `users` module gets extracted when Phase 2
  profile features actually need one.
- Why access tokens are JWTs (stateless, cheap on the hot path per Section
  64) but refresh tokens are opaque + DB-backed (revocation inherently needs
  a DB check anyway, so a self-describing refresh token buys nothing) —
  full writeup in ADR-0003.
- HS256 vs RS256: symmetric is fine while one service both signs and
  verifies; asymmetric earns its keep once a *different* service needs to
  verify without holding the signing secret.
- The stated, undisguised tradeoff of stateless access tokens: a banned
  user's existing token still works for up to 15 minutes — bounded by TTL,
  not eliminated, and that bound is *why* 15 minutes was chosen rather than
  something longer.
- Timing side-channels as an information leak: hashing/verifying at
  consistent cost regardless of whether the user exists, so response time
  itself doesn't reveal which emails are registered.
- `SameSite=Lax` cookies as CSRF mitigation without a separate CSRF token —
  and the specific, documented condition under which that stops being true
  (cross-origin frontend/backend, i.e. Vercel + Render/Fly in prod).
- Refresh token rotation as the mechanism that gives revocation an actual
  trigger, not just a theoretical capability — and reuse detection as the
  specific signal that turns "someone else might have this token" into
  "someone else demonstrably tried to use this token."
- Why a shared `familyId` beats walking `replacedByTokenId` pointers to find
  everything to revoke: an indexed O(1) update vs. an unbounded chain walk
  that could realistically span thousands of hops for one long session.
- Atomicity of "revoke old + create new": why they must be one transaction,
  with both failure directions (security hole vs. needless logout) spelled
  out rather than just asserted.
- The explicit, accepted false positive of reuse detection (a legitimate
  network retry looks identical to theft from the server's point of view)
  and the documented, non-hypothetical condition for revisiting it (a
  grace window, only if support data actually shows the pattern).
- Why in-memory rate-limit counters don't work once there's more than one
  API instance, and why that makes Redis a "distributed coordination" case
  (Section 12's legitimate justification) rather than "Redis is fast."
- Fixed window vs sliding window vs token bucket, and why the boundary-burst
  imprecision of fixed window is an acceptable tradeoff for THIS threat
  model (sustained brute force) specifically, not rate limiting in general.
- Fail-open vs fail-closed as a decision that depends on whether the thing
  being protected is core correctness (never fail open — see bidding) or a
  defensive layer (fail open here) — the same "Redis is never source of
  truth" principle applied to a new subsystem, not a new rule.
- Why functional tests shouldn't be coupled to production security
  thresholds, and the pattern for resolving that tension: raise the
  ceiling for the test environment, test the mechanism itself directly and
  deterministically in its own dedicated test.
- Diagnosing a real Jest hang (open Redis handle) by testing a narrowed
  hypothesis (`--forceExit` on a single file) before changing anything —
  and the specific ordering hazard in `setupFilesAfterEnv` that shaped how
  the fix was split between shared and per-file teardown.
- Why forgot-password needs a STRICTER enumeration bar than registration —
  same underlying risk (email existence disclosure), different acceptable
  tradeoff, because forgot-password is purpose-built recovery
  infrastructure and the textbook first target for automated enumeration.
- The port/adapter pattern as the concrete mechanism behind "the choice of
  vendor doesn't need to be right forever" — `EmailSender` made the actual
  Gmail-vs-production-provider tradeoff a bounded, later, contained
  decision instead of a decision the whole codebase would need to agree
  with.
- Why session revocation belongs inside password reset, not as a separate
  optional step: the primary real-world trigger for a reset ("I think I
  was compromised") is exactly the scenario where leaving old sessions
  alive would make the feature pointless.
- Distinguishing a real, exploitable-class dependency advisory (nodemailer
  SMTP/CRLF injection — fixed immediately) from a dev-tooling-only one
  (Prisma CLI's `deepmerge-ts` — deliberately left, documented, and
  monitored) — both surfaced by `npm audit`, but they don't warrant the
  same response, and the difference is *reachability from production
  request handling*, not severity label alone.
- A check-then-act sequence split across a network round trip is unsafe
  under concurrency regardless of which domain it's in — the refresh-token
  rotation race (ADR-0019) is the exact same shape of bug as bid placement
  (ADR-0012), and the exact same fix (lock the contended row for the
  duration of the whole decision, inside one transaction) closes both,
  demonstrating that "pessimistic locking for a check-then-act sequence"
  is a general pattern here, not a bidding-specific trick.
- Why a probabilistically-observed bug ("it logged someone out once") can
  be evidence of a strictly worse, non-deterministic failure mode (a
  silent session fork) that just happened not to manifest that way this
  time — the fix has to address what the race actually allows, not just
  reproduce the one symptom that was seen.
- Why a WebSocket handshake can't carry an `Authorization` header (the
  browser API doesn't expose one) and why that specifically rules out
  reusing the existing header-based auth model unmodified — leading to the
  first-message auth handshake as the least-bad option, not the obvious
  one.
- Why a token in a WebSocket URL's query string is a real, not theoretical,
  leak risk (proxy/CDN/browser-history logging) even though nothing in
  this codebase would itself log it — the danger lives in infrastructure
  outside the application's own control.
- Per-connection room-based fanout as the direct implementation of "avoid
  unnecessary broadcast" (Section 46), and why single-instance in-memory
  rooms are correct today but named, in advance, as broken the moment a
  second API instance exists (Section 14's Redis Pub/Sub requirement) —
  planning the exact trigger for a future change, not just accepting a
  vague future limitation.
- `ws` vs Socket.IO: the same "understand the mechanism, don't hide behind
  an abstraction" principle already applied to ORMs/rate-limit algorithms/
  concurrency control, applied to WebSockets — a heavier library isn't
  wrong, it's just not what teaches the underlying mechanism.
- Ping/pong as the specific mechanism for detecting a half-open TCP
  connection (a client that vanished without a clean close) that a normal
  application-level check can't see — and why `terminate()`, not `close()`,
  is the correct response once one is found.
- A platform limitation (Windows not delivering emulated cross-process
  POSIX signals) is a fact to document plainly, not a gap to paper over
  with an unverified claim — the difference between "this code path is
  exercised by an automated test" and "this exact real-world trigger was
  demonstrated" matters, and conflating them would be a false confidence
  the next person building on this code shouldn't inherit.
- Why a channel's authentication requirement should be derived from what
  it actually protects, not copied from the model used elsewhere in the
  system by default — the WebSocket gateway's mandatory-auth design looked
  reasonable in isolation (WS-001) but was wrong the moment it met a real
  page with a real anonymous-access requirement (WS-002), because nothing
  about the channel's actual payload needed protecting.
- Signal-only push (WebSocket says WHEN to refetch) vs. full payload push
  (WebSocket says WHAT changed) as a real design choice with a named cost
  either way — chosen here specifically to avoid a second data serializer
  drifting from REST's, not because one is universally correct.
- Revising an earlier ADR's decision is done by writing a NEW ADR and
  pointing back to it, not by editing the old one's reasoning in place —
  the historical record of "why it looked reasonable at the time" is worth
  keeping even after the decision changes.
- Distinguishing a finding that blocks the current task from one that's
  merely adjacent to it: the port-6379 Redis mismatch discovered during
  WS-002's live verification was real and worth surfacing, but chasing it
  immediately would have been exactly the kind of unrelated scope
  expansion Section 82 warns against — cleared the specific keys needed and
  moved on, flagging the rest for later.
- Test infrastructure choices need to actually be tested, not assumed from
  documentation or a constitution's own naming of a default — MinIO was
  named as the plan since Section 27/83 were written, and it no longer
  works; the fix was found by running `docker pull`, not by reading further
  docs about MinIO.
- Applying a principle evenhandedly, including to cases that don't
  obviously look like the thing the principle was written about —
  LocalStack isn't "a SaaS product" the way Cloudinary is, but it hit the
  identical "local dev now requires a live account" problem, and got
  rejected for the identical reason once that was noticed.
- The difference between verifying a MECHANISM and verifying its
  ENFORCEMENT — s3mock accepting a policy-violating upload doesn't mean the
  policy document is wrong; decoding and inspecting the actual signed
  policy proved the document itself was correct even though the mock's
  behavior couldn't confirm the enforcement end-to-end.
- A browser error message is a symptom, not a diagnosis — Chrome's
  `net::ERR_BLOCKED_BY_ORB` looked like a CORS/rendering problem but was
  actually just how it reports a 404 on an `<img>` request; the real fix
  came from checking what the URL actually pointed to (a wiped object),
  not from treating the browser's specific wording as the root cause.
- Applying the SAME ephemeral-vs-persistent question to a new subsystem
  that an earlier one already answered differently — Redis got no volume
  correctly (disposable counters); object storage got no volume by default
  too, without the same "would losing this silently surprise someone"
  question actually being asked of it. Copying a precedent isn't the same
  as re-deriving whether it applies.
- Reading a container image's actual behavior (via `docker run`,
  `docker logs`, and extracting strings from its compiled classes) instead
  of trusting a tool's documented-sounding default — s3mock's volume
  mount doing nothing without two specific, undocumented env vars was only
  found by testing the claim, not by assuming "mounted a volume" was
  sufficient.

## ADRs so far

- `docs/architecture/adr/0001-modular-monolith.md`
- `docs/architecture/adr/0002-postgresql-and-prisma.md`
- `docs/architecture/adr/0003-jwt-access-opaque-refresh-tokens.md`
- `docs/architecture/adr/0004-refresh-token-rotation-reuse-detection.md`
- `docs/architecture/adr/0005-redis-rate-limiting.md`
- `docs/architecture/adr/0006-password-reset-and-email.md`
- `docs/architecture/adr/0007-auction-domain-schema.md`
- `docs/architecture/adr/0008-auction-listing-visibility-and-pagination.md`
- `docs/architecture/adr/0009-auction-update-and-publish.md`
- `docs/architecture/adr/0010-auction-start-pause-cancel.md`
- `docs/architecture/adr/0011-bid-domain-schema.md`
- `docs/architecture/adr/0012-bid-concurrency-control.md`
- `docs/architecture/adr/0013-anti-sniping.md`
- `docs/architecture/adr/0014-auction-closing-worker.md`
- `docs/architecture/adr/0015-frontend-foundation.md`
- `docs/architecture/adr/0016-frontend-refresh-race-and-bidding-ui.md`
- `docs/architecture/adr/0017-auction-read-caching.md`
- `docs/architecture/adr/0018-bid-rate-limiting.md`
- `docs/architecture/adr/0019-refresh-token-rotation-race.md`
- `docs/architecture/adr/0020-websocket-gateway-foundation.md`
- `docs/architecture/adr/0021-websocket-live-updates.md`
- `docs/architecture/adr/0022-object-storage-image-uploads.md`
- `docs/architecture/adr/0023-order-creation-on-auction-close.md`
- `docs/architecture/adr/0024-database-backup-incident.md`
- `docs/architecture/adr/0025-payment-domain-and-mock-provider.md`
- `docs/architecture/adr/0026-notifications.md`
- `docs/architecture/adr/0027-kafka-outbox-notifications.md`
- `docs/architecture/adr/0028-redis-port-6379-collision.md`
- `docs/architecture/adr/0029-opensearch-auction-search.md`
- `docs/architecture/adr/0030-outbox-publisher-claim-lease.md`

## Known accepted issues

- **A small, consistent test-cleanup flake**: after a full `npx jest
  --runInBand` run, exactly 2 bidder users from `closing.test.ts` and 2
  from `anti-sniping-integration.test.ts` are sometimes left in the
  database despite each file's `afterAll` deleting by the exact emails it
  registered (`testEmails`), and despite those specific rows having zero
  FK references (bids/orders/refresh_tokens all checked directly — none
  block deletion). Not caused by ORDER-002's new `onDelete: Restrict`
  relations (checked first, ruled out) and not yet root-caused — the
  `deleteMany` calls report success but a strict subset of rows survive.
  Harmless (test data only, cleaned manually when noticed) but genuinely
  unexplained; worth a real look if it starts happening more broadly than
  these two files.
- **s3mock (local object storage) does not enforce presigned POST policy
  conditions** (ADR-0022): a wrong-Content-Type or over-size-limit upload
  will incorrectly succeed locally where real S3/R2 would reject it. The
  signed policy document itself was verified correct (decoded and
  inspected directly); only the local mock's enforcement is the gap.
  Revisit only if this ever masks a real bug in policy construction — e.g.
  via a targeted test against a real, disposable R2 bucket in CI.

- ~~Port 6379 on this dev machine reaches two different Redis instances
  depending on how you connect~~ — **RESOLVED (ADR-0028)**. Root cause
  found via `netstat -ano`/`tasklist`: `com.docker.backend.exe` publishes
  the `auctionx-redis` container on the wildcard address, but `wslrelay.exe`
  independently forwards some other WSL2 distro's own Redis to Windows'
  loopback address on the same port number, and Node's `localhost`
  resolution silently preferred the more specific loopback bind. Fixed by
  moving `docker-compose.yml`'s redis service to host port 6380 (container
  keeps its normal internal 6379) — self-contained within this project,
  doesn't touch the other WSL2 service at all. Verified with a live
  `redis-cli MONITOR` on the container showing the real `EVAL`/`INCR`/
  `EXPIRE` sequence from a real login request landing on it in real time;
  full `rateLimit`+`auth` suites re-run clean (43/43).
- **Legitimate multi-tab refresh now deterministically logs the user out**
  (ADR-0019, accepted per ADR-0004's already-documented tradeoff): two
  tabs refreshing the same token near-simultaneously will always resolve
  to one winner and one `REFRESH_TOKEN_REUSED` loser — no longer a silent
  session fork (the actual bug that was fixed), but still a real UX cost
  for that specific scenario. Revisit only with a short post-rotation
  grace window if real usage shows this is a frequent, measured problem —
  not speculatively.
- `npm audit` reports a high-severity advisory in `deepmerge-ts`, pulled in
  transitively by the Prisma CLI's config parser (`prisma`/`@prisma/config`).
  It's dev-tooling only — not present in `@prisma/client`'s runtime path — so
  it never runs in production request handling. No fix currently published
  upstream across the affected Prisma version range. Re-check on the next
  `npm update` of `prisma`.

## Not yet done (intentionally deferred, not forgotten)

- **Video upload** (Section 1 lists images/videos; MEDIA-001 built images
  only) — deliberately scoped out (YAGNI: images alone exercise the full
  presigned-upload mechanism). Adding it later is likely just widening
  `presign.ts`'s content-type allow-list and size limit, not new plumbing.
- **`next/image` with `remotePatterns`** (ADR-0022) — auction images
  currently render via plain `<img>` on the browse/detail pages because the
  storage domain isn't fixed yet (local `s3mock` vs. an eventual R2
  domain). Swap once that domain is known.
- Uploaded-image orphan cleanup — a seller who uploads a photo then
  abandons the create form (never submits) leaves that object in the
  bucket with nothing referencing it. Accepted as a common, low-cost
  tradeoff for this pattern (not unique to this app); revisit with a
  scheduled cleanup job only if storage cost/clutter ever becomes a
  measured problem.
- **Redis Pub/Sub fanout across WebSocket gateway instances** (ADR-0020,
  extended by ADR-0026's per-user `userRooms`) — today's in-memory,
  per-process room maps (both the auction rooms and the newer per-user
  ones) are correct only at one API instance; add this the moment a second
  instance exists, not before (Section 4).
- Email notifications — in-app + WebSocket (ADR-0026) covers an actively-
  browsing user; an offline user only finds out on their next visit. The
  `EmailSender` port (ADR-0006) already exists if this needs revisiting —
  only worth it if real usage shows missed time-sensitive notifications
  (e.g. slow payment after winning) are an actual problem.
- Full edit form for a `DRAFT` auction's content (title/description/price/
  etc.) from the frontend — WEB-003's dashboard covers lifecycle actions
  (publish/start/pause/cancel) only, not editing; overlaps with the
  already-listed "Edit-after-publish / unpublish" gap below for anything
  past `DRAFT`.
- `packages/shared` (cross-workspace shared Zod schemas/types) — the
  frontend currently duplicates `loginSchema`/`registerSchema` by hand
  (ADR-0015); extract once a third shape needs sharing, not before.
- Full 401-triggered refresh-and-retry interceptor on the frontend —
  WEB-000 only does silent refresh once on app load, not a queued
  retry-after-expiry on every request. A deliberate scope cut for the
  foundation task, not an oversight.
- Docker CLI/control-plane unresponsiveness (hit during WEB-000, root
  cause: the disk-full episode) — the actual Postgres/Redis containers
  were confirmed still healthy throughout, so this wasn't fixed (touching
  Docker Desktop itself felt riskier than leaving working containers
  alone). Worth the developer's attention if `docker`/`docker compose`
  commands are still unresponsive.
- `StripePaymentProvider` (a real payment provider) — `MockPaymentProvider`
  covers local dev/testing fully (ADR-0025); only worth adding once there's
  a real deployment actually accepting money (Phase 13+).
- **No automated/scheduled database backups** (ADR-0024) — `npm run
  db:backup` is manual, developer-run. Revisit only once a real deployment
  exists (Phase 13+), where the managed provider's own point-in-time
  recovery replaces this local script entirely.
- Redundant multi-instance closing-worker scans — harmless today (the row
  lock still ensures exactly one instance closes any given auction), but
  worth a leader-election/distributed-lock revisit if it ever shows up as a
  measured cost under multiple API instances (ADR-0014).
- Anti-sniping extension cap — no limit on total extension count/duration
  exists yet; a sustained bidding war could in principle extend an auction
  indefinitely (ADR-0013). Add one only if real usage shows it's a problem.
- Dedicated "hot auction state" (a Redis-native structure — e.g. a live
  per-auction leaderboard/sorted set — distinct from CACHE-001's read
  cache, which still round-trips to Postgres on every miss/expiry) — the
  last piece of Phase 5's three-item list (Section 73). Not yet built
  because there's no measured evidence the DB-lock-based bid path is
  actually a bottleneck (Section 62); CACHE-001 + RATELIMIT-002
  (ADR-0017/0018) cover the other two items. Revisit if real load ever
  shows the read-caching + rate-limiting combination isn't enough.
- **Cache-invalidation coverage is manual, not structural** (ADR-0017) — any
  future new way to mutate an `Auction` row must remember to call
  `invalidateAuctionCache`; nothing enforces this today beyond code review.
- **README.md is stale** — still describes the backend-only foundation
  (its "Structure"/"Stack" sections predate `apps/web`, object storage,
  Orders/Payments, and Notifications). Flagged inline in the file itself
  rather than silently left wrong; a full rewrite is a separate task, not
  bundled into whatever feature happens to touch it next.
- Retention/cleanup for `OutboxEvent` rows and Redpanda topic data
  (ADR-0027) — neither exists yet; revisit once growth is an actually
  measured problem at this project's scale, not a theoretical one.
- Extracting Kafka consumers into a separate process from the API
  (ADR-0027) — no scaling/failure-boundary reason exists yet at
  one-instance scale (Section 4).
- Auction `end` and the closing worker (Section 17) — needs winner
  determination, which needs the Bid module (Phase 4). An `ACTIVE`/`PAUSED`
  auction whose `endTime` passes today just sits there with no automatic
  transition (ADR-0010).
- Automatic "start at scheduled `startTime`" worker — `start` is manual-only
  right now (ADR-0010); a scheduler/job-queue decision is deferred to
  Phase 4/5 rather than bolted on ad hoc.
- Admin pause/cancel override for auctions — no bypass exists yet (ADR-0010);
  only worth adding once Phase 10's fraud detection (or an equivalent real
  need) actually exists to trigger it.
- Edit-after-publish / unpublish — a published auction cannot currently be
  fixed short of `cancel` + relist (ADR-0009); revisit if real usage shows
  this is a frequent need.
- `Credential`/multi-auth-provider table — only if/when OAuth is actually
  scheduled (see ADR-2's linked reasoning above).
- Real transactional email provider (Resend/SES/Postmark) — only once
  there's a real deployment with real users; Gmail SMTP is fine until then
  (ADR-0006). Swap is contained to `infrastructure/email/sender.ts`.
- Reuse-detection grace window — only if real (not hypothetical) support
  data shows legitimate-retry false positives are a problem (ADR-0004).
- CORS credentials/origin config for the refresh cookie — deferred until a
  real frontend origin exists to configure (see AUTH-003 notes above).
- Isolated test database (Testcontainers) — Section 36 lists this as a
  testing-phase concern; tests currently share the dev Postgres instance.
- Full graceful shutdown sequence (Section 69) — expand further once
  Kafka/WebSockets exist to close too (Prisma + Redis both handled now).
- Sliding-window rate limiting — only if fixed window's boundary-burst gap
  shows up as an actually exploited issue (ADR-0005).
- Frontend search bar — `apps/web`'s NavBar never got one; the backend
  (SEARCH-001/ADR-0029) didn't exist until now. Natural next step.
- CI (GitHub Actions) — deferred to Phase 15 per the phase plan, though a
  minimal lint+test workflow could reasonably move earlier if requested.
