# 0007 — Auction Domain Schema

## Context

Phase 3 (`CLAUDE.md` Section 73) starts the Auction module: create, update,
publish, start, pause, cancel, end. Before any endpoint exists, the
underlying entity needs to encode its own lifecycle and money handling
correctly, because Section 82 is explicit: never trust client-controlled
auction state or client-controlled prices — the server/database must be the
only source of truth for both.

## Problem

Three separate design problems had to be resolved before writing `Auction`:

1. **Lifecycle** — an auction is a state machine (Section 17/18), not a
   boolean. Invalid transitions (e.g. bidding on a `DRAFT` auction) must be
   structurally rejectable, not just "the client wouldn't send that."
2. **Money** — bid correctness (Phase 4) depends on price fields with exact,
   unambiguous arithmetic. Floating point is disqualified outright.
3. **Forward compatibility with bidding** — Section 10's bid-processing
   transaction updates auction state atomically alongside the bid insert.
   The field it updates needs to already exist on this table now, or Phase 4
   starts with a breaking migration on a table already in production use.

## Options Considered

### Money representation

1. **Integer cents (`Int`)** — exact, matches the minor-unit convention real
   payment providers (Stripe-shaped, Phase 8) use natively.
2. **Postgres `Decimal`/`NUMERIC`** — exact, no magnitude ceiling, reads more
   naturally in raw SQL, but requires a `Decimal.js`-wrapper type through the
   JS/TS layer and a conversion boundary the moment a cents-native payment
   provider is integrated.
3. **`Float`/`Double`** — rejected outright; IEEE 754 cannot represent
   currency exactly (`0.1 + 0.2 !== 0.3`).

### Category modeling

1. **Enum** (chosen) — fixed, small, code-controlled vocabulary, same
   justification already used for `Role`/`UserStatus` (ADR-0002).
2. **Lookup table** — needed only if categories must be admin-editable at
   runtime or need hierarchy (e.g. "Watches > Vintage"); neither is a real
   requirement yet.

### `currentPriceCents` timing

1. **Add it now** (chosen) — it belongs conceptually to this table's
   lifecycle regardless of when bidding ships, and Phase 4's bid transaction
   needs a column to update atomically.
2. **Add it in Phase 4** — would mean a migration on a table that may already
   hold real auction rows in production by then, plus a backfill.

## Decision

- `Auction.status`: enum `DRAFT | PUBLISHED | ACTIVE | PAUSED | CANCELLED |
  ENDED`, defaulting to `DRAFT`.
- All monetary fields (`startingPriceCents`, `reservePriceCents`,
  `currentPriceCents`) are `Int` cents.
- `category`/`condition` are enums, not tables.
- `images: String[]` defaults to `[]` — a placeholder contract for object
  storage (Section 27), which isn't built yet.
- `seller` relation uses `onDelete: Restrict`, not `Cascade`.
- `endTime` (planned) and `endedAt` (actual) are separate nullable fields.
- Indexes: `sellerId`, `status`, and a composite `(status, endTime)` matching
  the Phase 4 closing worker's query shape.

## Why

- **Cents over Decimal**: keeps the entire money-handling domain in the same
  representation Payments will eventually receive/send to its provider —
  no conversion layer between Auctions and Payments. Accepted ceiling: `Int`
  supports up to ~$21M per field, which is not a realistic constraint for
  this platform's listings.
- **Enums over tables for category/condition**: avoids a join for a read
  that will happen on every single auction list/detail response, for a
  vocabulary that doesn't currently need to change without a deploy.
- **`currentPriceCents` now, not in Phase 4**: this table's row is exactly
  where the bid-processing transaction (Section 10) needs to write the new
  current price — same row, same transaction as the bid insert. Deferring
  this field would only move the migration later at higher risk (real data
  present) for no benefit.
- **`Restrict` over `Cascade` on `seller`**: `RefreshToken`/
  `PasswordResetToken` cascade because they're disposable session artifacts;
  an `Auction` is a business record. A user who has ever listed an auction
  must not be deletable out from under that history.
- **`endTime` vs `endedAt`**: anti-sniping (Section 18) moves `endTime`
  forward on a late bid; a `cancel` action ends an auction before its
  scheduled `endTime` entirely. Collapsing these into one field would make
  "did this run its full scheduled course, extend, or end early" impossible
  to reconstruct from the data afterward.
- **Composite `(status, endTime)` index**: this is the literal query shape
  the Phase 4 closing worker needs — "every `ACTIVE` auction whose `endTime`
  has passed" — as a direct index scan rather than a filtered table scan.

## Tradeoffs

```text
Integer cents:
+ Exact arithmetic, no floating-point error
+ Matches payment-provider minor-unit convention (Phase 8)
+ Simple integer comparisons for bid validation (Phase 4)
- Ceiling of ~$21M per field (Int32) — acceptable now, would need BigInt
  if ever exceeded
- Display/formatting requires a cents->currency conversion at the edge
  (not stored anywhere, deliberately — a formatting concern, not a data one)

Enums for category/condition:
+ No join on the hottest read path (auction listing)
+ Schema-enforced valid values
- Adding/renaming a value requires a migration + deploy, not an admin action
- No hierarchy (flat list only)

currentPriceCents added ahead of bidding:
+ No breaking migration when Phase 4 ships
- The field is unused (always equal to startingPriceCents) until Phase 4
  actually writes to it - a small, documented, intentional exception to
  "don't build for hypothetical future requirements," justified because the
  requirement isn't hypothetical, it's the very next phase on the same table
```

## Consequences

- Migration `20260913170044_add_auctions` applied; `User` gains an
  `auctions` back-relation.
- No API surface yet — this task is schema-only, mirroring how AUTH-001
  preceded AUTH-002 (Registration API). `services/api/src/modules/auctions/`
  (repository/service/controller/routes) is the next task.
- Bid-placement concurrency control (optimistic vs. pessimistic locking,
  Section 9) is deliberately **not** decided here — that belongs to the
  Phase 4 task where the actual contention exists, not to this schema task.

## Revisit Conditions

- Move `category` to a real table if it ever needs to be admin-editable at
  runtime or needs hierarchy — neither is true today.
- Move off `Int` cents to `BigInt` only if a real listing's price would
  overflow ~$21M — not expected for this platform.
- Add a `version` column (optimistic concurrency) or decide on
  `SELECT FOR UPDATE` (pessimistic) when the Phase 4 bid-placement task is
  actually implemented, informed by that workflow's real contention profile.
