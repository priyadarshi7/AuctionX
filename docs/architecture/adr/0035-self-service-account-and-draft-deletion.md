# 0035 — Self-service "delete my account" and "delete a draft auction"

## Context

Raised directly during a live incident: the developer asked to clear test
rows from the dev database, then asked to also delete their own real
account and its one real auction. The actual deletion attempt was blocked
by this session's own auto-mode safety classifier (a mass-delete guard),
which correctly refused to let an agent delete a user's data on a bare
"please delete" with no durable, user-owned mechanism behind it. The
developer's own follow-up redirected the request to where it belongs:
"provide a way so that user could delete his account and delete
unpublished auctions" — a real, missing product capability, not a one-off
database operation.

## Problem

Two different deletions, with two different constraints:

1. **Deleting an unpublished (DRAFT) auction.** Does this need new backend
   work at all?
2. **Deleting an account.** `Auction.seller`, `Bid.bidder`, and
   `Order.seller`/`buyer` are all `onDelete: Restrict` by deliberate design
   (ADR-0007: "a user who has ever listed an auction must not be deletable
   out from under that history"; `Bid`'s own schema comment: "append-only:
   never updated, never deleted"). A real `DELETE /me` can't just call
   `prisma.user.delete()` for an account with any transactional history —
   Postgres itself would reject it.

## Decision

**Draft auctions: no new backend endpoint.** `cancelExistingAuction`
(`modules/auctions/service.ts`) already accepts `DRAFT` in
`CANCELLABLE_STATUSES`, specifically so an abandoned, never-published
listing has a way to go away without hard-deleting the row (ADR-0007's own
reasoning). The gap was purely in the frontend: `AuctionRow.tsx` rendered
"Set price & publish" for a DRAFT but never surfaced the cancel action
that already existed for `ACTIVE`/`PAUSED`. Fixed by adding the same
`cancelControl` to the DRAFT action row, relabelled "Delete"/"Delete this
draft?"/"Yes, delete" instead of "Cancel" for that status specifically — a
DRAFT was never actually running, so "cancel" reads wrong even though it's
the identical endpoint and the identical soft state transition
underneath.

**Account deletion: new `DELETE /api/v1/auth/me`, gated on actual bid/order
history, not on auction ownership.** `deleteOwnAccount`
(`modules/auth/service.ts`) counts bids the caller placed, bids received
on auctions they own, and orders on either side (`getUserHistoryCounts`).
Any non-zero count throws a structured `409 ACCOUNT_HAS_HISTORY` naming
what's blocking it. When clean, `deleteUserAndOwnedAuctions` deletes the
user's own auction rows AND the user row in one transaction, rather than
just the user row — see the first draft of this decision below for why
that matters.

**A bug caught during this task's own live-verification pass, before
shipping**: the first version gated deletion on `auction.count({
sellerId })` with no status filter — i.e., owning ANY auction row at all,
regardless of status, blocked deletion. Walking through the actual
scenario this was built for (an account with one DRAFT auction) surfaced
the problem: "deleting" a DRAFT calls `cancelExistingAuction`, which sets
`status: CANCELLED` — it does NOT remove the row. So that auction would
still be counted after being "deleted" from the user's point of view, and
`prisma.user.delete()` would still fail Postgres's `onDelete: Restrict`
even after following the page's own instructions. Fixed by checking what
actually matters (did a Bid or Order ever get created, not whether an
Auction row exists) and deleting the user's own never-bid-on auctions
alongside the user row in the same transaction when that check passes.

Frontend: a new `/account` page (linked from the NavBar's existing avatar
circle, now an actual link instead of a static span) with the same
two-step "Delete my account" / "Yes, delete my account" / "Keep my
account" confirm pattern already established in `AuctionRow.tsx`'s cancel
control — surfacing the backend's own `ACCOUNT_HAS_HISTORY` message
verbatim when blocked, rather than a generic error.

## Why

**Reusing `cancel` instead of adding a hard-delete auction endpoint**:
Section 82 — "never silently change architecture." ADR-0007 already made
an explicit, reasoned decision that auctions are never hard-deleted.
Adding a new `DELETE /auctions/:id` that actually removes the row would
directly contradict a decision already on record, for a UI gap that the
existing action already closes.

**Blocking account deletion on ANY history, not attempting anonymization**:
a real "right to be forgotten" flow would anonymize (scrub PII, keep the
row for the business records it's attached to) rather than reject — that's
a meaningfully bigger feature (a whole account module Section 2 already
noted was deliberately skipped for this project) than what was actually
asked for here. The real, current need is letting a throwaway/test account
with no real history clean itself up — which a clear block-with-reason
fully satisfies — so anonymization is explicitly deferred, not silently
scoped out.

**Checking history counts before attempting the delete, not just catching
Postgres's P2003 restrict-violation**: a caught raw FK violation surfaces
as an opaque, unhelpful error; counting first produces a specific,
actionable `ACCOUNT_HAS_HISTORY` message instead.

## Tradeoffs

```text
+ Zero new database schema, zero change to ADR-0007's established
  auction-deletion stance — both features are thin layers over decisions
  and endpoints that already existed.
+ The blocking check is a hard, structural guarantee (the same Restrict
  constraints that already protect this data), not just an application-
  level courtesy that could be bypassed by a bug elsewhere.
- Deliberately NOT a full "right to be forgotten" — an account with real
  transaction history has no self-service deletion path at all right now,
  only a clear explanation of why. Acceptable at this project's current
  stage (explicitly a learning/dev project, Section 1, not yet handling
  real users' real data at any compliance-relevant scale).
- The DRAFT-relabelling in AuctionRow.tsx ("Delete" vs "Cancel" for the
  exact same mutation) is presentation-only — someone reading the network
  tab would see identical POST /:id/cancel calls either way. Documented
  here so it isn't mistaken for two different code paths later.
```

## Consequences

- `services/api/src/modules/auth/repository.ts` gained
  `getUserHistoryCounts`/`deleteUserAndOwnedAuctions`; `service.ts` gained
  `deleteOwnAccount`; `controller.ts`/`routes.ts` wired
  `DELETE /api/v1/auth/me` behind `authenticate` (no dedicated rate
  limiter — same reasoning as the existing admin `PATCH /users/:userId/
  status`: self-only, destructive-but-rare, the global `apiRateLimit`
  already covers it).
- New `tests/auth/delete-account.test.ts` (6/6 passing): unauthenticated
  rejection, a clean account actually deleted, the refresh cookie cleared
  on success, an account that owns a DRAFT auction successfully deleted
  WITH that auction, an account that placed a bid correctly blocked, and
  a seller whose own auction received a bid correctly blocked — the last
  two are what actually exercises the bug described above; without the
  fix, the DRAFT-owning test would have falsely blocked too.
- New `apps/web/app/account/page.tsx`; `apps/web/lib/auth.ts` gained
  `deleteAccountRequest`; `apps/web/app/NavBar.tsx`'s avatar circle is now
  a link to `/account` instead of inert.
- `apps/web/app/my-auctions/AuctionRow.tsx`'s existing `cancelControl` is
  now also rendered for `DRAFT`, with status-aware wording.

## Revisit Conditions

- If this project ever needs to handle real users' data under an actual
  compliance obligation (GDPR-style), revisit account deletion as
  anonymization rather than a hard block — this ADR's "Why" section
  already names that as the deferred alternative, not an oversight.
- If a third kind of "delete my own X" request shows up with the same
  shape (self-only, history-gated), consider whether the
  count-then-block pattern here is worth extracting — two instances
  (auctions via `cancel`, accounts via this ADR) is still fine hand-written.
