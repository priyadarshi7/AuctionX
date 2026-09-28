# 0023 — Order creation on auction close (reserve-price aware)

## Context

Section 19's payment flow starts with `Auction End -> Winner -> Order`. Up
through ORDER-002, `closeAuctionIfExpired` (`modules/auctions/repository.ts`)
picked the highest bid and marked the auction `ENDED`, but nothing recorded
that a winner existed or that they owe payment — no `Order` row, nothing
distinguishing "sold" from "unsold."

## Problem

Two distinct problems, found together while designing this task:

1. **No Order.** The system has no representation of "this auction has a
   winner, this is what they owe, this is who they pay." Everything
   downstream (Section 19's Payment Intent step, notifications, an order
   history page) needs this to exist first.
2. **`reservePriceCents` was already schema (Section 7 — money as integer
   cents) and validated on create/update (`auctions/schema.ts`) but never
   read by the closing worker.** An auction with a $500 reserve that only
   reached $200 in bids was being treated as sold at $200. This is a
   correctness bug, not a missing feature — it predates this task (Phase 4)
   and was only caught while reading the closing transaction for this work.

## Options considered

**Where does Order get created?**

- *Asynchronously, via an event (Kafka/Outbox, Section 16).* This is the
  eventual shape once services split and downstream systems live outside
  this database. Rejected for now: Kafka doesn't exist yet (Phase 7
  untouched), and Order lives in the exact same Postgres database as
  Auction — introducing an event bus to write a second row in a database
  you already have an open transaction against is complexity with no
  present benefit. Revisit when Order creation needs to react to something
  genuinely outside this monolith, or when a separate Order service is
  justified (Section 4: only extract with a reason).
- **Synchronously, inside `closeAuctionIfExpired`'s existing transaction.
  Chosen.** The auction row is already locked (`SELECT ... FOR UPDATE`) and
  the winning bid is already being read under that lock to determine the
  outcome — creating the `Order` row is one more write inside a transaction
  that's already open, for data that already lives in the same database.
  This also gets idempotency for free: the lock guarantees
  `closeAuctionIfExpired` reaches its "determine winner" step at most once
  per auction (a second call on an already-`ENDED` auction returns early
  before ever re-evaluating the winner), and `Order.auctionId` is
  `@unique` as a second, schema-level backstop.

**What counts as a winner, given a reserve price?**

- *Reserve price ignored (the pre-existing, buggy behavior).* Rejected —
  this is exactly the bug this task exists to fix.
- **Highest bid must be `>= reservePriceCents` (when one is set) to
  produce an Order. Chosen.** This matches how reserve auctions actually
  work: the item goes unsold if the reserve isn't met, regardless of
  whether any bids came in below it.

## Decision

`closeAuctionIfExpired` now returns one of three outcomes:

- `NO_BIDS` — nobody bid. No Order.
- `RESERVE_NOT_MET` — bids exist, but the highest never reached
  `reservePriceCents`. Auction still ends (`ENDED`, `endedAt` set), but no
  Order — the item is unsold.
- `SOLD` — a winning bid exists and met the reserve (or there was no
  reserve). An `Order` row is created in the same transaction:
  `auctionId`, `winningBidId`, `sellerId` (copied from the locked auction
  row), `buyerId` (the winning bid's `bidderId`), `amountCents` (the
  winning bid's amount), `status: PENDING_PAYMENT`.

New `Order` model (`prisma/schema.prisma`): `auctionId` and `winningBidId`
are both `@unique` — an auction can close at most once (guaranteed above)
and a bid can win at most once, so each should be able to back at most one
Order, enforced by the schema, not just application logic. Both `Auction`
and `Bid` use `onDelete: Restrict` toward `Order`, matching every other
"business record, not disposable" relation in this schema (`Auction.seller`,
`Bid.auction`) — an Order can't be orphaned by deleting what it refers to,
though in practice neither Auction nor Bid rows are ever deleted in normal
operation.

## Tradeoffs

- Order creation is now coupled to `closeAuctionIfExpired`'s transaction —
  if `Order` creation itself needs to change in a way that risks failing
  (a future constraint, a trigger, etc.), that failure now rolls back the
  auction's `ENDED` transition too. Acceptable today: Order creation here
  is a single simple insert with data already validated by the lock.
- No notification/email is sent to the winner yet — `notifyAuctionChanged`
  fires the same generic `lifecycle` signal it always did (WS-002), which
  causes the auction detail page to refetch and show the new `ENDED`
  status, but there's no dedicated "you won" signal yet. Deferred
  intentionally to the Payment tasks, where the buyer needs to *act*
  (pay), not just be informed.

## Consequences

- The reserve-price bug is fixed for all auctions closing from now on;
  auctions that already closed under the old logic are not retroactively
  corrected (no backfill — there is no reliable way to tell, after the
  fact, whether an old "winner" would have been rejected by this logic
  without risking undoing a real transaction a user may have already
  acted on outside the system).
- `CloseAuctionResult`'s shape changed (now includes `outcome` and
  `orderId`, and is a discriminated union on `closed`) — the closing
  worker (`auctionClosingWorker.ts`) and its logging were updated to match;
  no other caller existed.

## Revisit conditions

- When Kafka/Outbox (Phase 7) exists and something outside this monolith
  needs to react to "auction sold" — move Order creation to consume an
  event instead of running inline.
- If auctions ever need multiple simultaneous winners (e.g. multi-item
  lots), the one-`Order`-per-auction `@unique` constraint needs revisiting.
