# 0014 — Auction Closing Worker

## Context

Section 17 describes auction closing as its own critical distributed
workflow: deterministic, idempotent, concurrency-safe, retryable, and
triggered by "auction reaches end time," not by a human action. This is the
last piece deferred since AUCTION-005 (ADR-0010): every other Phase 3/4
lifecycle piece is done, but nothing has ever transitioned an auction into
`ENDED`.

## Problem

Three questions: what actually watches for an auction's time running out
(nothing does yet — there's no automatic worker of any kind in this
codebase); how closing determines a winner without racing a bid that lands
at the same moment; and whether a human should ever be able to trigger
`end` directly, the way `cancel` is directly triggered.

## Options Considered

### Should a manual `end` endpoint exist?

1. **`POST /:id/end`, seller-triggered** (mirroring `start`/`pause`/
   `cancel`) — rejected. Section 73's Phase 3 lists `end` as a lifecycle
   action, but Section 17 frames it as something that happens because time
   ran out, not because someone clicked a button. A seller who wants to
   stop bidding on demand already has `cancel` (ADR-0010); a manual `end`
   would be a redundant, confusing second way to do roughly the same thing,
   with no distinct real trigger of its own.
2. **No manual endpoint; closing only ever happens via the worker**
   (chosen) — matches Section 17's own diagram exactly.

### How the worker is triggered

1. **A separate worker process** — more "production-correct" separation of
   concerns, but adds a second thing to deploy and run before there's a
   real reason to (Section 4's own principle: don't introduce
   infrastructure before it's justified — the same reasoning that kept
   Redis/WebSockets out of Phase 0-3).
2. **An in-process `setInterval` inside the same API process** (chosen) —
   no new deployable, no new infrastructure. Started alongside the HTTP
   server, stopped during graceful shutdown (Section 69) exactly like the
   existing Prisma/Redis cleanup.

### Concurrency between the worker and a live bid

1. **A separate lock/mechanism for closing** — would duplicate work and
   risk the two mechanisms disagreeing about what "current" means.
2. **Reuse the exact same `SELECT ... FOR UPDATE` on the auction row that
   bid placement already uses** (chosen, ADR-0012's mechanism) — a bid
   landing at the same instant the worker tries to close naturally
   serializes against it, for free, with no new primitive.

## Decision

- `modules/auctions/repository.ts` gains `findExpiredActiveAuctionIds(now)`
  (an unlocked candidate scan: `status IN (ACTIVE, PAUSED) AND endTime <=
  now`, using the composite index from ADR-0007) and
  `closeAuctionIfExpired(auctionId, now)` (the real transaction: lock the
  row, re-verify it's still actually expired under the lock's authoritative
  view, determine the winner by reading `Bid`, mark `ENDED` with `endedAt`).
- `infrastructure/jobs/auctionClosingWorker.ts`: a `setInterval` (5s) that
  scans and attempts to close every candidate, sequentially, logging each
  successful close (`auction.closed`, with the winning bid id if any).
  Started in `server.ts` alongside `app.listen`; stopped in the graceful
  shutdown handler.
- No `POST /:id/end` HTTP endpoint exists.
- A `PAUSED` auction past its `endTime` is also closed by the worker — pause
  suspends new bids, it doesn't stop the clock.
- `bids/service.ts`'s existing `AUCTION_SCHEDULE_EXPIRED` check (added in
  BID-002, before this worker existed) is now explicitly a belt-and-
  suspenders guard for the gap between "time technically ran out" and "the
  worker's next 5-second tick," not the only thing standing between an
  expired schedule and an accepted bid.

## Why

- **Reusing the bid-placement lock, not inventing a second one**: this is
  the same insight ADR-0012 already established — contention belongs
  scoped to the one row it's actually about. A worker attempting to close
  auction X and a bidder placing a bid on auction X are contending for the
  exact same resource (who gets to be the last word on this auction's
  state), so they should use the exact same lock, not two different
  mechanisms that could disagree.
- **Re-verifying expiry under the lock, not trusting the scan's own read**:
  the unlocked candidate scan can be stale by the time a specific
  auction's turn comes up — anti-sniping (ADR-0013) could have pushed its
  `endTime` out in the meantime. Re-checking under the lock is what makes
  this correct rather than merely "usually correct."
- **In-process interval over a separate process**: at this stage there's
  exactly one API instance and no existing job-queue infrastructure
  (Kafka/BullMQ/etc. don't exist until later phases) — a `setInterval` is
  the simplest thing that is actually correct, and multiple API instances
  (Section 47 Stage 2) redundantly scanning is a harmless inefficiency, not
  a correctness bug, because the row lock still ensures only one instance's
  transaction ever actually closes a given auction.
- **No manual `end`**: adding an endpoint with no real, distinct trigger
  scenario (beyond what `cancel` already covers) would be inventing API
  surface nobody asked for.

## Tradeoffs

```text
In-process setInterval worker:
+ Zero new infrastructure or deployables
+ Reuses the exact same concurrency primitive as bid placement — no new
  correctness surface to reason about
- Multiple API instances each independently scan and redundantly attempt
  every candidate — wasted, but harmless, work (Section 47 Stage 2)
- A closing delay of up to SCAN_INTERVAL_MS (5s) between an auction's real
  endTime and it actually transitioning to ENDED — acceptable at this
  stage; a Kafka-scheduled or cron-driven trigger could tighten this later
  if ever needed
```

## Consequences

- Order creation (Section 19: "Auction End -> Winner -> Order -> Payment
  Intent") is NOT part of this task — no `Order`/`Payment` module exists
  yet (Phase 8). Closing today only determines and logs the winning bid id;
  nothing downstream reacts to it yet.
- No outbox event is emitted on closing either (Phase 7 territory, same
  reasoning as bid placement's own deferred outbox event, ADR-0011/0012).
- This closes out every item on Section 73's Phase 3 AND Phase 4 lists.

## Revisit Conditions

- If multiple API instances redundantly scanning ever shows up as a real,
  measured cost (not hypothetical), consider a leader-election or
  distributed-lock approach to have only one instance run the scan —
  Section 62: measure first.
- Move from `setInterval` to a scheduled job system once one exists for
  other reasons (Phase 7's Kafka-based workers, or a dedicated job queue) —
  not worth introducing just for this.
- Wire actual downstream reactions (Order creation, notifications, outbox
  events) to `auction.closed` once their owning modules exist.
