# 0011 — Bid Domain Schema

## Context

Phase 4 (`CLAUDE.md` Section 73) begins: place bid, concurrency control,
idempotency, transactions, anti-sniping. Section 9 frames bidding as the
system's central high-contention workflow, and Section 82 is explicit:
never trust client-controlled prices or auction state. Before writing the
place-bid endpoint, the `Bid` entity needs a shape that makes several
things structurally true, not just documented as intent.

## Problem

Three questions had to be answered before writing the schema:

1. **Does a `Bid` row represent every attempt, or only accepted ones?**
2. **How is "who's currently winning" known** without a separate value that
   has to be kept in sync on every new bid?
3. **How does idempotency work** for an action with no natural uniqueness
   key (Section 11 names bid placement as the canonical example needing
   one, unlike registration's `email`)?

## Options Considered

### What gets persisted

1. **Every bid attempt, including rejected ones, with a `status` column**
   — preserves a complete attempt log (useful for fraud analysis, Section
   21), but means every read of "the current highest bid" has to filter by
   status, and every write has to decide what status to stamp.
2. **Only accepted bids, no `status` column** (chosen) — a bid that didn't
   beat the current price is rejected with a 400 at the API boundary and
   never reaches the database. The table becomes a simple, append-only
   ledger of what actually happened to the auction's price.

### Tracking the current highest bid

1. **A stored `isWinning` boolean, flipped on every new bid** — requires an
   extra write (unset the old winner, set the new one) inside the same
   transaction as every bid insert, and one more piece of state that can
   drift from reality if that write is ever missed.
2. **Derive it from bid order** (chosen) — because every accepted bid must
   exceed the previous price (enforced at write time, BID-002), the most
   recent bid for an auction is *by construction* the highest one. No
   extra column, no extra write, no drift risk.

### Idempotency key scope

1. **Globally unique `idempotencyKey`** — simpler uniqueness constraint,
   but two different users coincidentally choosing the same key string
   (extremely unlikely with UUIDs, but not the actual concern) would
   collide across unrelated bids, which is the wrong failure mode for a
   mechanism that's supposed to protect one caller's retries.
2. **Unique per `(bidderId, idempotencyKey)`** (chosen) — matches how real
   payment APIs (Stripe-shaped, already the mental model since ADR-0007)
   scope idempotency keys to the calling account, not the whole system.

## Decision

```prisma
model Bid {
  id        String  @id @default(uuid())
  auctionId String
  auction   Auction @relation(fields: [auctionId], references: [id], onDelete: Restrict)
  bidderId  String
  bidder    User    @relation(fields: [bidderId], references: [id], onDelete: Restrict)

  amountCents    Int
  idempotencyKey String

  createdAt DateTime @default(now())

  @@unique([bidderId, idempotencyKey])
  @@index([auctionId, createdAt])
  @@index([bidderId])
  @@map("bids")
}
```

- No `status` column; the table only ever holds bids that were accepted at
  write time.
- `amountCents`, matching `Auction`'s money representation (ADR-0007) — same
  domain, same convention, no conversion boundary.
- `onDelete: Restrict` on both relations, same reasoning as `Auction.seller`:
  a bid is a financial/audit record, never silently destroyed by deleting
  the user or auction it references.
- `idempotencyKey` is required, not optional — bid placement has no natural
  uniqueness key the way registration had `email`, so the client-supplied
  key is the only mechanism available.

## Why

- **Append-only, no status**: simplifies every future read. "What's the
  current highest bid for this auction" is `ORDER BY createdAt DESC LIMIT
  1` (or, in practice, just reading `Auction.currentPriceCents`, which
  BID-002's transaction keeps in lockstep) — never a query that has to
  remember to filter out rejected attempts.
- **No stored `isWinning` flag**: removing a piece of state that would
  otherwise need a second write inside the bid transaction removes a
  category of bug (that write failing or being forgotten) entirely, not
  just mitigates it.
- **Per-bidder idempotency scope**: keeps the guarantee precisely where it
  matters — "if I retry my own request, I get my own original result" —
  without inventing a cross-user collision concern that was never real.

## Tradeoffs

```text
No status / append-only:
+ Simplest possible "who's winning" query — no separate flag to maintain
+ No ambiguity about what a row means: every row is a real, accepted bid
- No log of rejected attempts (e.g. "user tried to bid too low 5 times") —
  if that data becomes valuable for fraud signals (Section 21, Phase 10),
  it will need a separate, explicit decision then, not a retrofit onto
  this table's meaning

Per-bidder idempotency key:
+ Matches a well-understood, industry-standard convention
- A client that reuses the same key against a DIFFERENT auction still
  succeeds (the key is scoped to (bidderId, key), not (bidderId, auctionId,
  key)) — this is intentional: the key's job is "don't double-submit MY
  request," not "constrain what I'm allowed to bid on"
```

## Consequences

- No outbox event on bid placement yet, even though Section 10's full bid
  pipeline describes one — the Outbox Pattern is Phase 7 (Section 73).
  This phase's bid-placement transaction is scoped to "insert bid + update
  auction," nothing more, until Kafka and the outbox worker actually exist
  to consume an event.
- Concurrency control for the actual bid write (pessimistic `SELECT FOR
  UPDATE` vs. optimistic versioning, Section 9) is deliberately not decided
  here — this is a schema-only task, mirroring AUCTION-001. BID-002 makes
  that call against the real contention pattern.
- A seller bidding on their own auction (shill bidding) is not prevented by
  this schema — it's a cross-table business rule that belongs in BID-002's
  service layer, not something a foreign key can express.

## Revisit Conditions

- If fraud detection (Phase 10) needs a record of rejected bid attempts
  (not just accepted ones), that's a deliberate, separate decision to make
  then — likely a distinct table, not retrofitting `status` onto this one
  and changing what "a row in `Bid`" has always meant.
- If bid retraction ever becomes a real product requirement, that changes
  the "never updated, never deleted" invariant this schema currently
  assumes — not a change to make speculatively now.
