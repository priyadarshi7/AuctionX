# 0018 — Bid-Specific Rate Limiting

## Context

Section 30 lists "Bid: special high-performance strategy" as its own line
item, distinct from the generic API rate limiting AUTH-006 already built.
This is the second of Phase 5's remaining pieces, alongside CACHE-001
(ADR-0017).

## Problem

`apiRateLimit` (ADR-0005) already applies to every `/api/v1/*` route,
including bid placement: 300 requests/minute for an authenticated user. That
number was sized for ordinary API traffic — reads, occasional writes. Bid
placement is not ordinary: `placeBidTransactionally` (ADR-0012) takes a real
Postgres row lock (`SELECT ... FOR UPDATE`) on **every** attempt, including
one that gets rejected for being too low. A user (or script) that fires
bid attempts rapidly at one hot auction spends real lock-hold time that
serializes against every other genuine bidder contending for that same row
— a materially different, worse cost profile than a normal request, and
300/min is far too loose a ceiling to meaningfully bound it.

Critically, this is **not** the same problem as Section 46's "hot auction"
scenario, which is many *different* bidders each bidding a normal number of
times — that's the system working correctly, and `apiRateLimit`'s per-user
keying already lets it through untouched. The problem is one identity
concentrating attempts on one auction.

## Options Considered

1. **Raise the bar by tightening `apiRateLimit` itself** — rejected: that
   limiter is deliberately generic (Section 30 calls for *different* limits
   per endpoint category, not one number for everything), and tightening it
   for all `/api/v1/*` traffic to suit bidding's cost profile would
   needlessly throttle unrelated reads.
2. **Key a bid-specific limiter by user alone** — rejected as imprecise: it
   would also throttle a user legitimately bidding across several different
   auctions at once, none of which individually stress any single row's
   lock.
3. **Key by `(user, auction)`** (chosen) — bounds exactly the quantity that
   actually matters: how much lock-contention pressure one identity can put
   on one specific auction. A user bidding normally across many auctions is
   unaffected; a script hammering one hot auction is capped fast.

## Decision

`bidRateLimit` (`middleware/rateLimit.ts`), reusing the same generic
`rateLimit()` factory and fixed-window Lua mechanism AUTH-006 already built
— no new infrastructure, just a new configured instance:

```text
Key:              ratelimit:bid:user:{userId}:auction:{auctionId}
TTL:              10 seconds (fixed window)
Value:            integer request counter
Source of truth:  N/A — same as every other rate-limit counter (ADR-0005)
Invalidation:     TTL expiry only
Consistency:      eventually consistent across a Redis restart — a
                   momentary loss of throttling, not a correctness problem
Failure behavior: fail open (same as every rateLimit() instance) — a Redis
                   outage lets bids through rather than blocking the whole
                   bidding path on a defensive layer's failure
Hot-key risk:     one aggressive bidder/script on one auction is the
                   expected hot key here by design — that's exactly the
                   case this exists to bound
```

`max: 10` per 10-second window. Stacks on top of `apiRateLimit`, mounted
after `authenticate` (needs `req.user`) and before `validateBody` — same
ordering pattern `authRateLimit` already established stacking with
`apiRateLimit`.

The `(user, auction)` key derivation is extracted into a standalone,
exported `bidRateLimitKeyBy` function specifically so it's unit-testable on
its own — the generic blocking/header/fail-open mechanics are already
fully covered by `tests/rateLimit.test.ts` against `authRateLimit` and
`forgotPasswordEmailRateLimit`'s shapes; the only genuinely new code here is
the key shape itself.

## Why

- **10 per 10 seconds, not something smaller**: anti-sniping (ADR-0013)
  assumes a real bidding war can produce several genuine re-bids from the
  same person within a short window as they get outbid and respond — the
  ceiling needs headroom for that human pattern, not just the bare minimum.
  It's still far below what a script attempting genuine DoS-via-lock-time
  would want to sustain.
- **Coupling the real threshold to a live check, not a Jest test**: the
  same reasoning already established for `authRateLimit`/`apiRateLimit`
  (`tests/rateLimit.test.ts`'s own comments, and AUTH-006's "12 bad-
  credential login attempts against the real dev server" verification) —
  a functional test suite shouldn't be coupled to, and spuriously pass or
  fail because of, a production-tuned number. The mechanism is tested
  generically; this specific threshold is verified live.

## Tradeoffs

```text
+ Bounds the one cost dimension unique to bidding (lock time per attempt)
  without touching the generic apiRateLimit other endpoints rely on
+ Reuses 100% of AUTH-006's existing infrastructure — no new Redis usage
  pattern, no new failure mode to reason about
- Fail-open means a Redis outage removes this specific protection too,
  same accepted tradeoff as every other rate limiter in the system
- 10/10s is a judgment call, not measured from real traffic (none exists
  yet) — a real deployment may show it needs tuning either direction
```

## Consequences

- `middleware/rateLimit.ts` gains `bidRateLimitKeyBy` (exported, unit
  tested) and `bidRateLimit`.
- `modules/bids/routes.ts`'s `POST /` gains `bidRateLimit` in its
  middleware chain, after `authenticate`.
- **Verified live** against the real dev server: 10 rapid bid attempts on
  one fresh auction from one bidder all returned real validation results
  (too-low-price rejections, each still consuming the limiter's budget);
  the 11th and 12th returned `429 TOO_MANY_REQUESTS` with
  `X-RateLimit-Limit: 10` / a positive `retryAfterSeconds`; a request after
  the 10-second window had genuinely elapsed showed the counter reset
  (`X-RateLimit-Remaining: 9` on a fresh attempt).

## Revisit Conditions

- Tune `BID_RATE_LIMIT_MAX`/window if real usage data (once there's a real
  deployment) shows 10/10s is too tight for legitimate sniping wars or too
  loose against real abuse.
- If a hot-auction-aware Redis data structure (a live leaderboard / sorted
  set per auction) is ever built as "hot auction state" — Phase 5's third,
  still-open item — reconsider whether this limiter's key shape should
  change alongside it.
