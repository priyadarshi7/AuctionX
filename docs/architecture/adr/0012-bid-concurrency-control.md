# 0012 — Bid Placement Concurrency Control

## Context

Section 9 names bidding as the system's central high-contention workflow:
many users can attempt to bid on the same auction simultaneously, and
correctness (no lost bids, no double winners, no bid accepted out of price
order) matters more than raw throughput on any single auction. Section 36
requires this to be demonstrated with a real concurrency test, not just
asserted.

## Problem

Given N concurrent `POST /auctions/:id/bids` requests against the SAME
auction, the system must guarantee: every accepted bid strictly exceeds the
auction's price at the moment it was accepted, the auction's final
`currentPriceCents` matches the highest bid actually persisted, and no
accepted bid is ever lost (a response says 201 but no row exists) or
duplicated.

The naive approach — read `currentPriceCents`, compare in application code,
then write — has a classic race: two concurrent requests can both read the
same (stale) price, both decide their bid is valid, and both write,
producing either a lost update (the auction ends up at the lower of the two
bids) or two bids persisted where the second should have been rejected
against the first's (not-yet-visible) price.

## Options Considered

1. **Optimistic concurrency** (a `version` column; `UPDATE ... WHERE id = ?
   AND version = ?`, retry on zero rows affected) — the general-purpose
   default for most write conflicts, because most rows aren't actually
   contended and a wasted retry is rare. Rejected here specifically because
   its core assumption — conflicts are rare — is false for exactly the case
   Section 46 calls "Hot Auctions": a popular auction is, by definition, the
   case where many bidders contend for the SAME row at the SAME time. Under
   real contention, optimistic concurrency degrades into a thundering herd
   of retries, each one re-reading, re-validating, and re-attempting — pure
   wasted work that pessimistic locking never does.
2. **`SERIALIZABLE` isolation, let Postgres abort conflicting transactions**
   — correct, but Section 9 explicitly warns against reaching for
   `SERIALIZABLE` everywhere. It would convert every contended bid into a
   serialization failure requiring explicit retry logic in the application,
   solving the same problem `SELECT ... FOR UPDATE` solves more directly
   under the default `READ COMMITTED` isolation level.
3. **Pessimistic locking: `SELECT ... FOR UPDATE` on the auction row inside
   a transaction** (chosen) — every bid attempt on one auction serializes
   behind that auction's row lock. The transaction holding the lock reads
   the guaranteed-current price, decides, writes, and releases; the next
   waiter then sees the fresh, post-commit state.

## Decision

`placeBidTransactionally` (`modules/bids/repository.ts`) runs the entire
bid-placement pipeline as one `prisma.$transaction`:

1. `SELECT id, "sellerId", status, "currentPriceCents", "endTime" FROM
   auctions WHERE id = $1 FOR UPDATE` — raw SQL, since Prisma's query
   builder has no row-locking API.
2. Re-check idempotency (see below), then run business validation
   (ownership, auction status, schedule, price) against the now-guaranteed-
   current row.
3. Insert the bid, update the auction's `currentPriceCents`.
4. Commit — releasing the lock for the next waiter.

Business validation itself (`assertBidIsAcceptable`, `modules/bids/
service.ts`) is injected into the repository function as a callback rather
than hardcoded in the transaction, keeping business rules in the service
layer like every other module — but it necessarily runs *inside* the lock,
because validating outside it would reopen the exact race this design
exists to close.

## Why

- **A row lock, not a table lock**: concurrent bids on *different* auctions
  never block each other. Contention is scoped to exactly where the actual
  conflict exists — the same auction row — matching Section 46's framing of
  hot auctions as an isolated hot-key problem, not a system-wide one.
- **No retry logic needed**: unlike optimistic concurrency or
  `SERIALIZABLE`, a blocked transaction here simply waits for the lock and
  then proceeds — there's no serialization failure to catch, no backoff to
  tune, no risk of a retry storm under exactly the load pattern (a hot
  auction) that would make one worst.
- **Short transactions**: the locked section does one indexed row read, one
  insert, one update — sub-millisecond work. Serializing sub-millisecond
  transactions still supports very high throughput per auction; the lock's
  cost is proportional to actual contended work, not overhead.

## Tradeoffs

```text
Pessimistic locking (SELECT ... FOR UPDATE):
+ No wasted retries under contention — the exact opposite of optimistic
  concurrency's failure mode
+ Simple to reason about: one waiter at a time, always sees fresh state
+ Different auctions never contend with each other
- A lock is held for the duration of the transaction — a slow query or a
  bug inside that transaction would block every other bidder on that ONE
  auction (mitigated by keeping the locked section deliberately minimal:
  one read, one insert, one update, nothing else)
- Doesn't parallelize at all for bids on the SAME auction, by design — this
  is correctness, not a limitation to optimize away later
```

## A real race this design surfaced (not hypothetical)

While writing the concurrency test, two identical-idempotency-key concurrent
bids on the SAME auction initially failed one of the two requests with
`VALIDATION_ERROR` ("bid must exceed current price") instead of replaying
the original 201. What happened: the losing request's `SELECT ... FOR
UPDATE` blocked behind the winner's transaction, then — once unblocked —
read the auction row with the winner's OWN price update already applied.
Its identical bid amount no longer exceeded that (now-current) price, so it
was rejected by ordinary price validation before ever reaching an insert
attempt — meaning a `P2002` unique-constraint catch (the mechanism that
handles idempotency races everywhere else in this codebase, e.g.
registration's email race, AUTH-002) never had a chance to fire.

The fix: re-check `(bidderId, idempotencyKey)` a second time, inside the
transaction, immediately after acquiring the lock, *before* running price
validation. Because every bid on one auction serializes behind that same
lock, whichever request acquires it second is guaranteed to see any
sibling's already-committed insert at that point — closing the race
completely for same-auction key reuse.

This does **not** cover the same idempotency key reused across two
*different* auctions concurrently (ADR-0011's documented, accepted
tradeoff: the key is scoped to the bidder only, not also the auction) —
those two requests lock different rows and can't see each other via this
mechanism. That case still relies on the outer `P2002` catch in
`service.ts`, which remains necessary specifically for it, not as unused
defensive code.

## Consequences

- No outbox event is emitted on bid acceptance yet — Phase 7 territory
  (ADR-0011). Downstream reactions to a new bid (notifications, WebSocket
  fanout for live updates, fraud scoring) don't exist yet and aren't
  triggered by this transaction.
- No dedicated bid-specific rate limiter yet, despite Section 30 calling for
  "a special high-performance strategy" for bidding — the global
  `apiRateLimit` applies for now; a hot-auction-aware strategy is Phase 5's
  job (Redis infrastructure), not something to improvise ahead of it.
- Anti-sniping (extending `endTime` on a late bid, Section 18) is not part
  of this task — it's a natural next task now that bid placement itself is
  correct under contention.

## Revisit Conditions

- If profiling under real load shows lock wait time itself (not the
  underlying contention, which is inherent to correctness) is a measurable
  bottleneck, investigate whether the locked section can be shrunk further
  — not whether to abandon pessimistic locking, since the alternative
  (optimistic) is strictly worse under the exact load pattern that would
  trigger this investigation in the first place.
- Revisit the cross-auction idempotency-key-reuse gap only if real usage
  shows it causing actual confusion — ADR-0011 already accepted it as a
  tradeoff, not an oversight.
