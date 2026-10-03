# ADR-0042: Review-stage hardening and the READ COMMITTED snapshot fix

## Context

Using the review stage (ADR-0041) live exposed two product bugs, and chasing a
long-standing "timing-sensitive" bid test exposed a real concurrency bug in the
merged bid transaction (ADR-0036 addendum).

## Problem

1. A listing cancelled before it ever went live became a public CANCELLED
   auction and appeared in Browse.
2. The admin list showed other people's unsubmitted drafts, and admin Cancel
   was offered on pending listings (where Approve/Reject is the real decision).
3. Seller start/pause/cancel were read-then-write, so a click racing the closing
   worker could overwrite an ENDED auction that already had an Order.
4. A banned user's access token worked on every endpoint except bids/listing
   for up to 15 minutes.
5. Bidders were not told when an admin cancelled an auction they bid on.
6. The 5-document cap was soft under concurrent registrations.
7. **Bid transaction (the important one).** In READ COMMITTED, when a
   `SELECT ... FOR UPDATE OF a` has to wait for the lock, Postgres re-reads the
   locked `auctions` row afterwards but every other table in the statement keeps
   the snapshot from before the wait. The merged locked read joined `bids` for
   (a) the idempotency re-check and (b) the previous top bid, so under
   contention (a) a retry that waited behind its own twin rejected itself as
   "too low" and (b) the outbid notification could name the wrong bidder.
   Separately `createdAt` used `now()` (transaction START time), so bid history
   could be ordered differently from price order.

## Decision

- **Never-live listings are hidden.** Cancelling from DRAFT/PENDING_REVIEW
  clears `startTime`; "CANCELLED with no startTime" (`isNeverLive`) is excluded
  from Browse, search indexing and non-owners. No migration needed.
- **Admin queue.** Drafts are never in the admin list; admin cancel applies only
  to PUBLISHED/ACTIVE/PAUSED. Pending listings are decided by approve/reject.
- **Seller start/pause/cancel are guarded UPDATEs** (ADR-0038's idiom); a
  state change in between returns 409 instead of overwriting.
- **Blocked-user marker.** Restricting an account writes `user:blocked:{id}` in
  Redis (TTL = token lifetime + 60s); `authenticate` refuses marked users with
  `ACCOUNT_DISABLED`. It fails open if Redis is down; bids/listing still
  re-check status in PostgreSQL, so money paths stay closed.
- **Bidders are notified** (one per distinct bidder, idempotent under
  redelivery) when an admin cancels an auction.
- **Document cap is exact**: registration locks the auction row, checks
  `status = DRAFT` and the count, then inserts. It serializes against the
  seller's submit, which takes the same row lock.
- **Bid transaction.** The previous-top-bid lookup moved into the write
  statement as a CTE (a fresh snapshot taken while the lock is held, ordered by
  amount); the outbid event is built in SQL from it. Bid `createdAt` uses
  `clock_timestamp()`. The idempotency join in the locked read stays as a
  best-effort fast path; a miss is safe because the unique
  `(bidderId, idempotencyKey)` index rejects the insert and `service.ts`
  replays after a fresh lookup (also after a business rejection from the
  precheck or the locked validation). Still two round trips.
- **Review queue visibility.** The dashboard shows how long the oldest pending
  listing has waited and turns red after 24 hours. No emails or escalation yet.
- Local Redpanda now advertises `127.0.0.1:9092` so the notifications
  integration tests can connect (recreate the container to apply).

## Why

The snapshot bug was invisible to unit tests and only surfaced under a genuine
same-key race, which is exactly the case idempotency exists for. Moving the
exact read into the statement that already runs under the lock keeps the
two-round-trip budget and removes the dependence on the pre-lock snapshot.

## Tradeoffs

- The blocked marker adds one Redis EXISTS (~60ms hop from Render) to every
  authenticated request. Accepted: it is the price of immediate revocation
  without a database read per request. `optionalAuthenticate` does not check
  it (anonymous-compatible routes only personalise).
- A replay lookup runs on bid rejections that have an existing bid for the
  same key; one extra read on a path that is already failing.
- Cancelling a never-live listing destroys its (unpublished) `startTime`.

## Consequences

Hidden-listing, ordering and replay behaviour are now covered by tests that
exercise the actual races. 267 backend tests.

## Revisit Conditions

- Move to a database-side `pg_advisory_xact_lock` or SERIALIZABLE only if a
  second cross-table read under the lock appears.
- Email or escalate stale review queues (SLA).
- Refunds (needs the real payment provider), orphaned document cleanup after
  account deletion, virus scanning, and browser (Playwright) tests are open.
