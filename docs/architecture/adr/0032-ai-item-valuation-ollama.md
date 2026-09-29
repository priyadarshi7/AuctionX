# 0032 — Phase 10: AI item valuation via a self-hosted Ollama model

## Context

Section 73's Phase 10 is AI. Section 20 specifies item valuation: given
images/description/category/condition (and, eventually, historical
auction data), produce `estimated_value`, `confidence`, `price_range`, and
`explanation`. Section 24 is the binding constraint on HOW this gets
built: AI must never sit on the bid or auction-creation critical path.
Section 83/the developer's own explicit direction for this phase: prefer
free, locally-deployable infrastructure over a paid cloud API, the same
principle already applied to object storage (R2/s3mock), search
(OpenSearch), and Kafka (Redpanda).

## Problem

Three things needed solving:

1. How does valuation happen without auction creation ever waiting on a
   model call (Section 24's literal example is exactly this: `Bid Request
   -> LLM -> Accept Bid` is the wrong shape; `Bid Request -> Fast
   deterministic path` with AI async elsewhere is the right one — same
   principle applies to auction creation, not just bids).
2. Which model actually runs the valuation, at zero cost and without a
   third-party account for local dev (Section 83's principle, applied to
   AI for the first time).
3. What does the system show while a valuation is still pending, and what
   happens when the model fails or produces garbage — an enhancement
   feature failing must never look like the whole system is broken, nor
   should a failure be invisible forever.

## Options considered

**Self-hosted Ollama vs. a cloud vision API (Gemini/GPT-4V-class)**: chose
Ollama, self-hosted in `docker-compose.yml`, the same "no managed free
tier exists for this piece of infra, so self-host it locally" reasoning
Section 83 already applies to OpenSearch/Kafka/ClickHouse/Qdrant. Real,
stated tradeoff: CPU-only inference on a small local model is materially
slower (seconds-to-tens-of-seconds per call, not milliseconds) and
meaningfully lower quality than a frontier hosted model — a local model
has no real market-pricing knowledge, so its price estimate is a rough
guess dressed up as a structured number, not an appraisal. This ships the
full pipeline correctly; it does not ship a good appraiser. Production
deployment is a genuinely open question this ADR does NOT resolve (see
Revisit Conditions) — none of this project's free-tier deploy targets
(Render/Fly) have the RAM/CPU to run even a small local model well.

**Model choice**: `moondream` (~1.6B, vision-capable) over a larger model
like `llava` (7B) — chosen specifically for CPU iteration speed on
hardware with no GPU, at a further real quality cost on top of the
Ollama-vs-cloud tradeoff above. A single env var
(`OLLAMA_VALUATION_MODEL`); swapping it is a config change, not a code
change.

**Trigger mechanism**: the exact same pattern Phase 9 already built and
this project now has real practice with — `createAuction`
(`modules/auctions/repository.ts`) writes a `PENDING` `AuctionValuation`
row AND an outbox event, atomically, in the same transaction as the
auction row itself; a dedicated Kafka consumer (`modules/ai/consumer.ts`)
picks it up and does the actual model call, off the request path
entirely. Deliberately NOT wired as a call into `modules/ai` from
`auctions/repository.ts` — the `AuctionValuation` row is created directly
there (`tx.auctionValuation.create(...)`), the exact same precedent
`Order` already set inside `closeAuctionIfExpired` (schema.prisma's own
comment on `Order`: a second write inside the same transaction is
strictly simpler than a cross-module call, when the two are this tightly
coupled). `auctions/repository.ts` still doesn't need to know Ollama
exists — only that it should publish to `AI_VALUATION_EVENTS_TOPIC`.

**Which Kafka topic?** A NEW dedicated topic, `ai-valuation-events` — same
two reasons `search-events` is dedicated (ADR-0029/0031): (1)
`modules/notifications/consumer.ts`'s DLQ-poison-message signal on
`auction-events` must not get corrupted by an unrelated event type, and
(2) test-scoping the TOPIC itself (`ai-valuation-events-test`), not just
the consumer group id, so a live dev server never independently receives
(and burns real Ollama CPU time processing) a test run's own
auction-creation events — ADR-0031 found the hard way that consumer-group
isolation alone doesn't prevent this.

**What does the consumer do on failure?** This is the one place this
design deliberately DIVERGES from `modules/search/consumer.ts`'s pattern.
Search's consumer throws on anything it can't handle, and lets
`infrastructure/kafka/consumer.ts`'s generic handler route the message to
`{topic}-dlq` — appropriate there because a malformed/unexpected message
is genuinely exceptional. Here, "the model was slow, unreachable, or
returned unparseable JSON" is an ORDINARY, expected condition for a
small local model, not exceptional — and nothing in this project
currently consumes or inspects any `-dlq` topic, so routing there today
is effectively a silent dead end nobody will ever see. `modules/ai/
consumer.ts` catches every failure internally and writes a `FAILED`
`AuctionValuation` row with an `errorMessage`, which the seller can see
and retry via `POST .../valuation/regenerate`. This is safe specifically
BECAUSE valuation is non-critical (Section 24) — the same choice would be
wrong for a payment webhook.

**What does GET return for an auction that predates this feature?** Chose
lazy backfill over a separate reindex-style script, directly applying the
lesson from ADR-0031's Problem 3 (pre-existing auctions never got
backfilled into search until a script was added after the fact):
`modules/ai/service.ts`'s `getValuation` creates a `PENDING` row and
triggers it right there if none exists yet, the first time it's ever
requested — no separate manual step needed this time, because the mistake
was seen once already and designed around up front instead of discovered
again the same way.

**Who can see a valuation?** Seller-only (`authenticate` + an ownership
check mirroring `modules/auctions/service.ts`'s `requireOwnedAuction`
exactly — 404 for a DRAFT owned by someone else, 403 otherwise). Section
20 frames this as a seller pricing tool, not a public signal — showing a
bidder "the AI thinks this is worth less than the asking price" would
actively work against the seller for no product reason.

## Decision

- `docker-compose.yml`: new `ollama` service (`ollama/ollama:latest`,
  ~3.6GB image — meaningfully heavier than every other local service in
  this project, worth knowing going in), a volume (model weights are
  gigabytes; re-downloading on every container restart would be real
  friction, same reasoning as OpenSearch's volume). Model weights
  themselves are NOT bundled in the image — `npm run ai:pull-model`
  (`docker exec auctionx-ollama ollama pull moondream`) is a one-time
  manual step after `docker compose up`, documented in `.env.example` and
  the compose file itself. The app boots fine either way; valuation just
  stays `PENDING`/`FAILED` until the model has actually been pulled.
- `prisma/schema.prisma`: `ValuationStatus` enum (`PENDING`/`COMPLETE`/
  `FAILED`), `AuctionValuation` model (`@unique` on `auctionId`, `onDelete:
  Cascade` — a derived AI artifact, not an independent business record,
  same distinction `Notification` already draws for its own `Cascade`).
- `infrastructure/ai/valuationProvider.ts` — a `ValuationProvider`
  interface, same seam pattern as `PaymentProvider`/`EmailSender`:
  `modules/ai`'s business logic depends only on this, never on Ollama
  directly, so a future cloud provider swap (the open production question
  below) touches one new implementation file.
- `infrastructure/ai/ollamaValuationProvider.ts` — the real implementation.
  Fetches up to 3 images (capped — CPU inference cost scales with every
  image sent to a shared, single container), base64-encodes them, calls
  Ollama's `/api/generate` with `format: 'json'`. The model reasons in
  whole USD, not cents — asking a small model to also get a correct x100
  unit conversion is asking for a second way to fail; the USD-to-cents
  conversion happens in code instead, where it's reliable. One bounded
  retry (Section 41 — not unbounded) on an unparseable response, with a
  stricter one-line prompt reminder appended. The point estimate is
  clamped to always fall inside the returned range in code — nothing
  guarantees a small model's own `low <= estimate <= high` internal
  consistency, and this is a cheap invariant to enforce rather than trust.
- `modules/ai/repository.ts`'s `requestValuationInTx` — the shared
  upsert-PENDING + publish-outbox-event primitive, used both by
  `auctions/repository.ts`'s `createAuction` (nested in its own existing
  transaction) and by `modules/ai/service.ts`'s `regenerateValuation`/
  lazy-backfill-on-GET (each in their own standalone transaction).
- `modules/ai/consumer.ts` — subscribes `ai-valuation-events` only,
  re-fetches the auction fresh from Postgres (never trusts the event
  payload beyond `auctionId`, same principle as the search consumer),
  calls the provider, writes `COMPLETE` or `FAILED` — see the "diverges
  from search" discussion above for why it never throws.
- `modules/ai/service.ts`/`controller.ts`/`routes.ts` — `GET` and `POST
  .../regenerate` under `/api/v1/auctions/:auctionId/valuation`
  (`mergeParams`, same pattern as `modules/bids/routes.ts`), both behind
  `authenticate` + ownership. `regenerate` also gets a new
  `aiRegenerateRateLimit` (5 per 10 min per user) — a genuinely different
  cost shape from the generic `apiRateLimit` ceiling, the same
  "this specific action is unusually expensive" justification
  `bidRateLimit` already established, except the resource being protected
  here is the single shared Ollama container itself, not one auction's row
  lock.

## Tradeoffs

- Valuation quality is genuinely rough — stated plainly, not hidden: a
  1.6B local model's price estimate should be read as "a plausible-sounding
  starting point," never as market research. This is the direct, accepted
  cost of the free/local choice.
- `ai-valuation-events-test`'s own topic accumulates indefinitely, same
  accepted gap ADR-0031 already flagged for `search-events-test` — no
  retention policy exists for either yet.
- A model failure is swallowed into `FAILED` rather than DLQ'd — means a
  systemic Ollama outage produces silently-FAILED rows for every auction
  created during it, discoverable only by a seller checking their own
  listing (or noticing PENDING never resolves) and clicking regenerate.
  Acceptable for a Section-24 enhancement feature today; would need real
  alerting before this pattern could be trusted for anything load-bearing.
- Three fetched images cap, not "however many the seller uploaded" — a
  seller with 8 photos gets a valuation based on only the first 3.

## Consequences

- Full test suite: 179/179 passing (165 prior + 14 new — 8 HTTP-layer
  authorization/lazy-backfill/regenerate tests in `tests/ai/
  valuation.test.ts`, 6 pure-function clamping/fallback tests in
  `tests/ai/ollamaValuationProvider.test.ts`).
- Verified live end-to-end, twice, against the REAL Ollama container (not
  mocked): created a real auction via the HTTP API with no images — its
  `AuctionValuation` row was already `PENDING` in the SAME response cycle
  as auction creation (no separate trigger call, confirming the
  same-transaction write), then transitioned to `COMPLETE` asynchronously
  via the consumer. Separately, uploaded a real PNG through the existing
  MEDIA-001 presign flow, created a second auction referencing it, and
  confirmed the image-attached path also completes — visibly slower
  (~12–15s vs. near-instant for text-only), the expected signature of the
  image actually being fetched, base64-encoded, and sent to the vision
  model, not silently skipped.
- **A real bug found and fixed during this exact live verification, not
  hypothetically**: the first attempt failed with `"Model did not return a
  parseable valuation after one retry"`. Calling Ollama directly with the
  identical prompt showed why — moondream reliably returns syntactically
  valid JSON matching every field, but sometimes leaves `explanation` as
  `""` rather than a real sentence. `rawValuationSchema`'s
  `explanation: z.string().min(1)` treated that as a validation failure
  indistinguishable from genuinely malformed output, throwing away an
  otherwise-perfectly-usable numeric result. Fixed: `explanation` accepts
  an empty string, with a plain fallback string (`"No explanation was
  provided by the model."`) substituted in `toResult` — an honest gap
  disclosed to whoever reads it, not a silently blank field. Re-verified
  live after the fix: both the original text-only auction (via
  `regenerate`) and the new image-attached one completed successfully.
- **The quality caveat from this ADR's own "Options considered" section is
  not theoretical — confirmed directly**: moondream's actual live estimate
  for "Vintage Rolex Submariner Diver Watch... genuine 1970s stainless
  steel dive watch" was **$0.13**, range $0.13–$0.15, confidence 0.16. This
  is not a bug — the pipeline worked exactly as designed, end to end; the
  MODEL's price knowledge is simply this poor. Left as-is deliberately: a
  low `confidence` value alongside an obviously-unreliable number is the
  honest signal this feature was designed to produce, not something to
  paper over by hand-tuning the prompt to produce nicer-looking fake
  numbers for a specific test item.
- Live verification test data (2 auctions, their valuations, 1 uploaded
  test image, 1 test user) cleaned up afterward — the uploaded object
  itself was left in `s3mock` (no delete path exists for objects yet,
  same pre-existing gap as every other test upload this project has made).

## Revisit Conditions

- **Production deployment is unresolved on purpose.** None of this
  project's free-tier targets (Render/Fly, Section 83) can run even a
  small local model well. The likely real answer at Phase 13+ is a cloud
  provider with a genuine free API tier (Gemini's is the strongest
  current candidate) implementing the same `ValuationProvider` interface
  — but that's a decision for when deployment is actually being built,
  not now (Section 83: don't let deployment constraints shape Phase 0–12
  architecture).
- If valuation quality proves too poor to be useful even as a rough
  signal, the next lever is a larger local model (`llava` or similar) —
  one config value, `OLLAMA_VALUATION_MODEL` — before reaching for a paid
  API.
- No automated Jest coverage of the actual Ollama call path (success →
  `COMPLETE`, failure → `FAILED`) — same precedent Phase 9's search set
  (no Jest tests at all, live-verified only) for an external-service-
  dependent derived feature. What IS covered: the pure `toResult`/`toCents`
  clamping logic (no network needed), and the full authorization/lazy-
  backfill/regenerate HTTP surface (`tests/ai/valuation.test.ts`) — the
  actual model call itself is verified live, documented below.
- Replay tooling for `*-dlq` topics still doesn't exist for ANY consumer
  in this project (ADR-0029's same open item) — irrelevant to this
  feature specifically since it deliberately never DLQs, but still an
  open gap for `search-events`/`auction-events`/`notifications` overall.

## Addendum (2026-09-29): real usage feedback — wrong flow, a serious
## pricing bug, and a related feature tried and removed

Three things came directly from the developer actually using this feature
after it shipped, not from further design review.

**Problem 1 — the valuation appeared too late to matter.** The original
create-auction form (`app/auctions/new/page.tsx`) chained
create → publish → start into one submit, so an auction was already LIVE
by the time anyone ever saw its valuation on the detail page. Reported
directly: "the AI valuation should come after I fill up details, before
publishing — I should be able to set my price on that page." The backend
design (async, Kafka-triggered, persisted per auction) was correct and
unchanged; only the frontend sequencing was wrong.

**Fix**: the create form no longer collects a price at all — only title/
description/category/condition/photos. It creates the `Auction` with a
nominal placeholder `startingPriceCents` (100, i.e. $1 — never shown,
always overwritten before publish is possible) purely because the
database column is a required positive int; nothing about a "price-less"
create was worth a schema change for this. The seller then lands on the
auction's own DRAFT page, where a new `SetPriceAndPublishPanel` sits right
below `ValuationPanel` — real price entry, reserve, duration, and
"Publish & start" all together, informed by (but never blocked by) the
valuation shown above it: a `FAILED` or still-`PENDING` valuation never
disables the price form, exactly as asked ("valuation failure should not
block me setting up a price and publishing it"). `ValuationPanel` itself
is now gated to `auction.status === 'DRAFT'` — it disappears entirely once
published, matching "the AI valuation should not appear after I publish."
`my-auctions`' own DRAFT quick-action (`AuctionRow.tsx`) was changed from
an inline "Publish & start" (which would have published at the leftover
placeholder price) to a link into the same real flow, rather than
duplicating a second price form.

**Problem 2 — a real, serious pricing bug, found while building the fix
above, not hypothetically.** `modules/auctions/repository.ts`'s
`AuctionPatch`/`updateAuctionRow` never touched `currentPriceCents` when
`startingPriceCents` was edited — a PATCH updated the seller-facing
`startingPriceCents` field but silently left `currentPriceCents` (the
actual floor `bids/repository.ts` checks a bid against) pointing at
whatever the auction was created with. Confirmed live: created a DRAFT at
the $1 placeholder, PATCHed it to $2,500, published and started it — the
stored row showed `startingPriceCents: 250000, currentPriceCents: 100`.
Had this shipped, a bid of $1.01 would have been accepted as the winning
bid on a $2,500 item. This bug almost certainly pre-dated this session's
work (the update-a-DRAFT's-price endpoint already existed before AI-001),
but nothing in the OLD frontend flow ever exercised "edit price while
still DRAFT" — the new create-then-price-later flow is the first real
caller of that path, which is what surfaced it.

**Fix**: `AuctionPatch` gained a `currentPriceCents` field (internal to
the repository layer only — the public `updateAuctionSchema`, Section 82,
still never accepts it from a client), and
`modules/auctions/service.ts`'s `updateExistingAuction` sets it in
lockstep with `startingPriceCents` whenever the latter is patched. Safe
unconditionally: a DRAFT can never have a real bid yet (bidding requires
`ACTIVE`), so "the price to beat" is always exactly the starting price
until first bid, with no ambiguity. Covered by a new end-to-end regression
test (`tests/auctions/update.test.ts`) that doesn't just check the stored
column — it patches a DRAFT's price, publishes and starts it for real,
then proves a bid that would have cleared the OLD placeholder price is
rejected while one clearing the NEW real price is accepted. 180/180 tests
passing.

**Problem 3 — the listing assistant (Section 23), built, then removed.**
Before the flow feedback above, a full second AI feature was built: an
Ollama-backed "listing assistant" (suggested title/description/category,
missing-info detection, image-quality notes), synchronous, its own
`ollamaClient.ts` shared with this file's provider, its own tests, its own
ADR (0033). It worked mechanically — including finding and fixing a real
prompt-design bug where the model echoed the prompt's own illustrative
placeholder text back as its "answer." But live use showed the deeper
problem Section 23's compound ask (rewrite a title AND a description AND
classify a category AND enumerate missing facts AND judge photos, all at
once) is meaningfully harder for this same small local model than
valuation's single-number-plus-sentence ask: calls regularly took over a
minute, sometimes exhausted both the model call and its one retry and
still failed. Reported directly: "the AI suggestion is taking way too
much time... remove the AI Listing Suggestion." Removed entirely —
`infrastructure/ai/listingAssistantProvider.ts`/
`ollamaListingAssistantProvider.ts`, `modules/ai/listingAssistant.*`,
`listingAssistantRoutes.ts`, their tests, the frontend panel, and
ADR-0033 itself all deleted rather than left as dead/disabled code. The
shared `ollamaClient.ts` extraction stayed (still used by this file's own
`ollamaValuationProvider.ts`) since it has independent value regardless of
the second caller going away.

`OLLAMA_VALUATION_MODEL` was renamed to `OLLAMA_VISION_MODEL` while the
listing assistant existed (a second feature using the same config value
made the old name misleading) — the rename was kept even after removing
that feature, since "vision model" remains the more accurate name for
what it configures either way. This ADR's own Revisit Conditions section
above still says the old name; treat `OLLAMA_VISION_MODEL` as current.

**Status of the actual accuracy problem** (a separate, still-open
complaint from the same feedback: "$0.12 for LV & Nike Collab Shoes" —
see the main Revisit Conditions above): confirmed live, with a plastic-
spoon control test, that the model genuinely reads the input (it gave a
different, more sane number for the cheap item) rather than returning a
canned response — it simply has close to no real pricing knowledge for
luxury/collectible items. `llava:7b` has been pulled and is ready to
test as the next lever (this ADR's own pre-existing Revisit Conditions
already named it as the right first move before reaching for a paid
API), deliberately deferred until this flow work landed first, per
explicit developer sequencing ("first work on this component, then we
will enhance the AI to perform well").
