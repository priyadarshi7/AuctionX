# 0017 — Cache-Aside for `GET /auctions/:id`

## Context

Phase 5 (Section 73) calls for three things from Redis: caching, rate
limiting, and hot auction state. AUTH-006 already delivered rate limiting.
This task is the first of the other two, and — per Section 62 ("never
optimize blindly") — it needs a real, measured reason to exist now rather
than "Redis is fast."

That reason now exists: WEB-002 added 5-second polling on the auction detail
page as a stand-in for Phase 6's WebSockets. Every browser tab with that page
open now issues a `GET /auctions/:id` every 5 seconds for the entire time an
auction is `ACTIVE`. A genuinely hot auction (Section 46) with hundreds of
watchers means hundreds of near-simultaneous reads of the exact same row,
almost all of which will see no change between polls. This is precisely
Section 13's motivating case, not a hypothetical one.

## Problem

`getAuctionForViewer` (`modules/auctions/service.ts`) hits Postgres on every
call. Reads don't take a lock (only bid placement does, ADR-0012), so this
isn't a contention problem — it's a redundant-round-trip problem: N watchers
polling every 5s is N Postgres queries every 5s for data that changes only
when a bid lands or the seller changes lifecycle state, which is rare by
comparison.

## Options Considered

1. **No cache, rely on Postgres** — rejected for this specific endpoint now
   that there's a measured, real polling load; fine for every other read
   endpoint, which stays uncached (see below).
2. **Cache the list endpoint (`GET /auctions`) too** — rejected for now. Its
   cache key would need to encode every filter combination × cursor ×
   viewer's draft-visibility, which explodes key cardinality for comparatively
   low payoff (browsing isn't polled every 5s the way one open detail page
   is). Revisit only if list-endpoint load is ever actually measured as a
   problem.
3. **Cache per-viewer response** (i.e. key by `auctionId:userId`) — rejected.
   Visibility (`canSeeDraftsFor`) is a cheap, synchronous check against fields
   already on the row; there is no reason to fragment the cache per viewer
   when the underlying resource is identical for everyone who's allowed to
   see it at all. Fetch/cache the canonical row once, apply the visibility
   check after retrieval regardless of whether the row came from cache or DB.
4. **Cache-aside on the single-item read, keyed by `auctionId` only**
   (chosen) — one cache entry per auction, populated lazily on first read
   after a miss, read by everyone regardless of role.

## Decision

Cache-aside, full `Auction` row, one key per auction:

```text
Key:              auction:{auctionId}
TTL:              5 seconds
Value:            JSON-serialized Auction row (Date fields revived on read)
Source of truth:  PostgreSQL — a cache miss or Redis outage always falls
                   back to it; nothing here is ever the only copy of the data
Invalidation:      event-driven — explicit DEL after every write that
                   changes this row (edit, publish, start, pause, cancel,
                   bid acceptance, worker close), PLUS the 5s TTL as a
                   backstop in case an invalidation call is ever missed
Consistency:      up to 5 seconds stale in the gap between a write and its
                   DEL (there isn't one — see below) or between TTL expiries
                   if a DEL is somehow missed
Failure behavior: fail open — a Redis error on GET or SET is logged and
                   treated as a miss; the request always still completes
                   correctly from Postgres, just without the speedup
Hot-key risk:     the busiest possible case (many watchers, one auction) is
                   exactly the case this helps most — many GETs on one Redis
                   key is normal, cheap Redis usage, unlike a DB row lock
```

Invalidation is explicit `DEL`, not `SET` with the new value — simpler, and
avoids re-deriving "is this write's result the same shape a viewer is
allowed to see" at the invalidation site. The next read just re-populates it
from Postgres.

Every write path that mutates an `Auction` row now calls
`invalidateAuctionCache(auctionId)` immediately after its own write commits
— never before, and never from inside the transaction itself. This is the
same principle Section 10 states for Kafka/outbox: only react after a
commit succeeds. An invalidation that ran before commit and then the
transaction rolled back would delete a still-valid cache entry for nothing;
one that ran inside the transaction would still be reacting to unconfirmed
data if some later step in that same transaction failed.

## Why

- **Fail-open is not a security tradeoff here, unlike rate limiting's**
  (ADR-0005) — there, failing open trades a security control for
  availability, a real and stated cost. Here, Redis is explicitly never the
  source of truth for anything (Section 12/40), so there is no correctness
  or security property being traded away at all: a cache miss just means
  "do what we always did before this task existed."
- **TTL exists as a backstop, not the primary invalidation mechanism** — an
  event-driven DEL after every write keeps staleness at effectively zero in
  the common case; the TTL only matters if a future code path forgets to
  invalidate. 5 seconds was chosen to match the frontend's own poll interval
  (WEB-002) — even in the worst case (an invalidation call is missed), the
  cache can never be staler than the polling loop makes acceptable anyway.
- **Caching the single-item GET, not the list GET**: the single-item
  endpoint has a real, current, measured hot spot (5s polling on the exact
  same key). The list endpoint doesn't have an equivalent access pattern
  yet — caching it now would be Section 62's "optimize blindly," not a
  response to a real bottleneck.

## Tradeoffs

```text
+ Removes the dominant read cost of a hot, actively-polled auction from
  Postgres entirely, in the common (no recent write) case
+ Zero behavior change for callers — getAuctionForViewer's signature and
  return value are unchanged; visibility rules are applied identically
  regardless of whether the row came from cache or DB
+ Fail-open means a Redis outage degrades performance, never correctness
- A missed invalidation call at some future write site is a real, silent
  risk class this introduces — bounded by the 5s TTL, but a bug nonetheless
- One more thing to keep in sync when adding a NEW way to mutate an Auction
  row in the future (a revisit condition, not a currently-open gap: every
  existing write path is covered as of this task)
```

## Consequences

- `infrastructure/redis/auctionCache.ts` (new): `getCachedAuction`,
  `setCachedAuction`, `invalidateAuctionCache` — all best-effort, all
  swallow Redis errors internally (logged, never thrown) so no caller needs
  its own try/catch around a cache operation.
- `modules/auctions/service.ts`'s `getAuctionForViewer` tries the cache
  first, populates it on miss, and applies `canSeeDraftsFor` identically
  either way.
- Every existing auction-mutating call site (`updateExistingAuction`,
  `publishExistingAuction`, `startExistingAuction`, `pauseExistingAuction`,
  `cancelExistingAuction`, the closing worker's `runOnce`, and
  `bids/service.ts`'s `placeBid`) now invalidates the cache for the affected
  `auctionId` right after its own write succeeds.

## Revisit Conditions

- If a new way to mutate an `Auction` row is ever added, it must also call
  `invalidateAuctionCache` — flag this in review, since nothing enforces it
  structurally today.
- Cache the list endpoint only if real usage shows list-read load
  (independent of the single-item hot path this task addresses) is an
  actual measured problem.
- If Phase 6's WebSockets replace the frontend's 5s polling entirely, this
  cache's payoff shrinks (no more read amplification to absorb) but doesn't
  disappear — any real hot auction still gets many independent reads
  (search results, direct links, etc.) even without polling.
