# 0029 — Phase 9: OpenSearch-backed auction search

## Context

Section 73's Phase 9 is Search. Until now, "browsing" auctions
(`GET /api/v1/auctions`) is exact-match Postgres filtering — category,
status, keyset pagination (ADR-0008) — with no way to find an auction by
what it's actually about ("vintage rolex," "pokemon card"). Section 25
specifies OpenSearch for this, with Postgres staying the source of truth
and the index built from `Postgres → Event → Search Index`.

Phase 7 (ADR-0027) already built exactly the mechanism this needs: the
Outbox pattern, publishing to Kafka/Redpanda, with idempotent consumers and
DLQ handling for poison messages. This phase is a genuine reuse of that
infrastructure, not a parallel one.

## Problem

Two things needed solving:

1. How does OpenSearch's index learn about an auction's current
   searchable state (title, description, category, price, status), and
   stay current as that state changes across six different mutation sites
   (create, update, publish, start, pause, cancel), auction closing (three
   outcomes), and every accepted bid (price)?
2. How does a search outage stay contained — Section 25's explicit
   requirement that "search unavailable must NOT corrupt auction state" —
   while the bid/auction critical path (Section 64) stays completely
   untouched by it?

## Options considered

**OpenSearch vs. Postgres full-text (`tsvector`)**: `tsvector` would have
avoided a new piece of infrastructure entirely and was a real option.
Chose OpenSearch because it's what Section 25 specifies and because it's
the actual system-design lesson worth having here: a genuine derived read
model, independently scalable and independently failable from the
transactional database (Section 39 — search may be stale, current bid may
never be). Tradeoff, stated plainly: this is a second datastore to run,
monitor, and keep in sync, for real added operational weight `tsvector`
wouldn't have carried.

**Verified before adopting, same discipline as Redpanda/s3mock**: pulled
the image (1.47GB — meaningfully heavier than Redpanda's ~400MB, worth
knowing, not alarming), ran it standalone with `discovery.type=single-node`
+ `DISABLE_SECURITY_PLUGIN=true`, and confirmed `_cluster/health` went
GREEN in ~10s. OpenSearch/Elasticsearch have a well-known history of
refusing to start on Linux hosts without a bumped `vm.max_map_count` — a
real, specific concern given this project's own recent Docker/WSL2
friction (ADR-0028). Did not reproduce here; this machine's Docker Desktop
WSL2 VM already has enough headroom.

**How does the index learn what changed — event payload carries the
diff, or just an id?** Chose "just an id." Every trigger site publishes
the SAME minimal event (`{ type: 'auction.reindex', auctionId }`);
`modules/search/consumer.ts` re-reads the auction fresh from Postgres and
upserts (or deletes, if DRAFT) the full document. Carrying fields in the
payload was rejected: it would mean the event shape has to track the
schema forever, and any mismatch (a forgotten field, a stale value from
before a later write) would silently drift the index from truth. Re-fetch-
then-index means every reindex recomputes the full picture from source of
truth, so a missed, duplicated, or out-of-order event self-heals on the
next one — verified for real (see Consequences).

**Which Kafka topic?** A NEW dedicated topic, `search-events` — NOT
`auction-events`, even though every trigger site for `auction.reindex`
already publishes to `auction-events` for other reasons (`auction.sold`,
`auction.reserve_not_met`). `modules/notifications/consumer.ts` also
subscribes to `auction-events` and — by design (ADR-0027) — treats any
`type` it doesn't recognize as a poison message and routes it to
`auction-events-dlq`. Publishing `auction.reindex` onto that same topic
would mean every single reindex event gets caught by that check and
DLQ'd, corrupting a signal that's supposed to mean "this message is
actually malformed" into "a message meant for a different consumer." A
dedicated topic keeps both consumers' DLQ signal meaningful — this is
Section 15's "topics should be designed intentionally" applied literally,
not just aspirationally.

**Search failure mode**: `modules/search/service.ts` wraps the OpenSearch
query and turns any failure into a `SearchUnavailableError` (503,
`SEARCH_UNAVAILABLE`) — never a silently-empty result set, which would lie
to the caller ("nothing matched" vs. the true "unknown, ask again"). The
Outbox means an OpenSearch outage can't lose a reindex signal either — the
row just stays unpublished (if Redpanda's also down) or the Kafka message
lands in `search-events-dlq` (if only OpenSearch is down, per `runConsumer`'s
existing any-failure-DLQs-it behavior) — either way, the NEXT event for
that auction (another bid, another edit) re-syncs it from current truth.

## Decision

- `docker-compose.yml`: `opensearch` service, single-node, security plugin
  disabled (no TLS/password setup for a local instance nothing external
  reaches — same reasoning as every other local dev service here), 512MB
  heap cap, a volume (unlike Redis — this data is real work to rebuild via
  a full reindex, even though it's derived and disposable in principle).
- `infrastructure/search/client.ts` — a plain `@opensearch-project/opensearch`
  client singleton, same shape as `infrastructure/kafka/client.ts`.
- `modules/search/repository.ts` — index mapping (`text` for
  title/description, `keyword` for category/condition/status, numeric/date
  for the rest), `ensureAuctionIndex` (idempotent bootstrap, same precedent
  as `ensureBucketExists`), `upsertAuctionDocument`/`deleteAuctionDocument`,
  and `queryAuctions` (relevance-ranked `multi_match` on `title^2` +
  `description` when `q` is present, filter clauses for
  category/status/price range, newest-first when there's no `q` to rank
  against).
- `modules/search/consumer.ts` — subscribes `search-events` only, re-fetches
  from Postgres, deletes-from-index for DRAFT/missing (ADR-0008: DRAFT is
  never publicly visible, must never be searchable), upserts otherwise.
- `modules/search/service.ts` / `controller.ts` / `schema.ts` / `routes.ts`
  — `GET /api/v1/search/auctions`, public (no `authenticate`, same as
  browsing), `q`/`category`/`status`/`minPriceCents`/`maxPriceCents`/
  `page`/`limit` query params.
- `auctions/repository.ts`'s six mutation functions (`createAuction`,
  `updateAuctionRow`, `publishAuctionRow`, `startAuctionRow`,
  `pauseAuctionRow`, `cancelAuctionRow`) each wrapped in a `$transaction`
  (they were plain single-statement calls before) to publish the reindex
  event atomically with the write — same reasoning as every other Outbox
  trigger site in this codebase. `closeAuctionIfExpired` publishes it
  unconditionally across all three outcomes (SOLD/RESERVE_NOT_MET/
  NO_BIDS), since status changes to ENDED either way.
- `bids/repository.ts`'s `placeBidTransactionally` publishes it
  unconditionally on every genuine new bid — deliberately NOT reusing the
  existing `bid.outbid` event, which is conditionally skipped (no previous
  bidder, or a bidder re-outbidding themselves) and would silently miss
  reindexing the very first bid on an auction.

## Tradeoffs

- A reindex event that fails while OpenSearch is down gets DLQ'd, not
  retried — verified live (see Consequences): the index stays stale for
  that specific change until the NEXT event for the same auction arrives,
  which re-syncs it from current truth. No automatic DLQ replay exists
  today (same gap as the notifications consumer's DLQ — ADR-0027 already
  accepted this for the identical mechanism).
- No `search_after`/scroll pagination — `from`/`size` only, capped by
  OpenSearch's default result-window limit. Fine at this project's scale;
  deferred (YAGNI) same as the other pagination-depth items already in
  `PROGRESS.md`'s "Not yet done."
- Six previously-simple single-statement repository functions are now
  transactions — a small real cost (one extra `INSERT` per call), accepted
  for the same reason every other Outbox trigger site in this codebase
  accepts it: atomicity between the write and the event describing it.

## Consequences

- Full test suite: 165/165 passing. (One unrelated, pre-existing race
  surfaced during this task's own verification, not fixed as part of it —
  see Revisit Conditions.)
- Verified live end-to-end, not just by test: created, published, and
  started a real auction ("Vintage Rolex Submariner Diver Watch") via the
  real HTTP API; it was findable via `GET /api/v1/search/auctions?q=rolex`
  on the first poll — matched on a description-only word ("dive") too, and
  correctly excluded by `category=ART`/`minPriceCents` filters that don't
  apply to it.
- DRAFT exclusion verified live: created a second, never-published DRAFT
  auction and confirmed a search unique to its title returned zero
  results, while a name-collision with pre-existing unrelated real data
  ("Pikachu Card," ACTIVE, created earlier in this same dev session) was
  initially mistaken for a leak — re-checked with a phrase unique to the
  DRAFT item and confirmed the exclusion is real.
- Failure mode verified live: stopped the OpenSearch container, confirmed
  `GET /api/v1/search/auctions` returns 503 `SEARCH_UNAVAILABLE` while
  `GET /api/v1/auctions`, `/readiness`, and placing a REAL bid (201, normal
  latency) all continued working untouched. Restarted OpenSearch, placed a
  second bid, and watched the index self-heal to the current price on the
  very next event — the exact behavior the "re-fetch, don't carry the
  delta" design is for.

## Revisit Conditions

- **Found, not fixed, during this task's own verification**:
  `infrastructure/jobs/outboxPublisherWorker.ts`'s `findUnpublishedOutboxEvents`
  has no row-level locking (no `FOR UPDATE SKIP LOCKED`) — two concurrent
  publisher instances (a live `npm run dev` server left running alongside a
  full test-suite run, both against the shared dev Postgres instance per
  `PROGRESS.md`'s already-tracked "Isolated test database" gap) can both
  select and publish the SAME unpublished row, producing two distinct
  Kafka messages for one logical event. This produced two flaky test
  failures (a duplicate OUTBID notification, a closing-worker race) that
  disappeared entirely once the stray dev server was stopped before
  re-running the suite — confirmed as the cause, not guessed. Real,
  pre-existing (Phase 7), unrelated to this task's own changes; worth a
  `SELECT ... FOR UPDATE SKIP LOCKED` fix on its own. **Resolved in
  ADR-0030.**
- Replay tooling for `*-dlq` topics — doesn't exist for any consumer yet
  (notifications' or search's). Worth building once a real (not
  hypothetical) need to recover a DLQ'd message shows up.
- `search_after`-based deep pagination, if real usage ever pages further
  into search results than `from`/`size` comfortably supports.
- A frontend search bar — `apps/web`'s NavBar deliberately never got one
  during the Phase 7-era frontend redesign specifically because this
  backend didn't exist yet. Natural next step now that it does.
