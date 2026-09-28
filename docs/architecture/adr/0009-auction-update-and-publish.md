# 0009 — Auction Update and Publish: Edit Gating and Transition Rules

## Context

AUCTION-002/003 built creation and reading. This task adds the first two
lifecycle actions from Section 73's Phase 3 list (create → update → publish
→ start → pause → cancel → end): editing a listing, and the `DRAFT` →
`PUBLISHED` transition. This is the first place the auction state machine
(Section 17, anticipated in ADR-0007) is actually enforced, not just
represented as an enum.

## Problem

Three separate questions needed answers before writing the endpoints:

1. **Who can mutate an auction, and what does denial look like** for a
   caller who isn't the owner?
2. **When is editing even legal?** A live, watched listing changing price
   out from under bidders is a real fairness problem, not a hypothetical one.
3. **What does `publish` actually require?** A `PUBLISHED` auction with no
   `endTime` is a bid pipeline (Section 10) with nothing to close.

## Options Considered

### Authorization failure shape

1. **Always 403 for a non-owner** — simple, but for a `DRAFT` auction (which
   ADR-0008 already made invisible to non-owners on `GET`) a 403 would leak
   that a specific, unpublished listing with this id exists — more than the
   read side ever reveals.
2. **Always 404 for a non-owner** — simple in the other direction, but wrong
   for a `PUBLISHED` auction: its existence is already public via `GET`, so
   hiding it behind a 404 on `PATCH` is pointless obscurity that also makes
   "is this a permissions problem or a real 404" ambiguous to a legitimate
   API consumer debugging their own integration.
3. **Split, matching the read-side visibility rule exactly** (chosen): 404
   when the underlying resource is itself invisible to this caller (a
   `DRAFT` owned by someone else), 403 when it's visible but the caller
   still isn't allowed to act on it.

### Admin bypass on mutations

1. **Admin can edit/publish anything** — consistent with admin's read-side
   bypass (ADR-0008), but there's no actual stated requirement for admin
   content moderation yet (Section 21's admin capability so far is account
   suspension, AUTH-005).
2. **No admin bypass on mutations** (chosen) — read visibility and write
   authority are different questions; collapsing them would grant a
   capability nobody asked for.

### Publish's schedule requirement

1. **Require both `startTime` and `endTime` explicitly, every time** —
   rejected as needless friction: if a seller already set them via `PATCH`,
   re-sending them on `publish` is pure boilerplate.
2. **Default both if absent** — rejected for `endTime`: a silently-chosen
   end time is exactly the kind of server-decided business fact (like a
   price) that should never be implicit.
3. **Default only `startTime` to "now"; require `endTime` from either the
   request or a prior update** (chosen) — "publish and start the countdown
   immediately" is the common case and deserves a default; "how long does
   this auction run" is a decision only the seller can make.

## Decision

- `requireOwnedAuction(userId, auctionId)` is the single shared check for
  both `PATCH /:id` and `POST /:id/publish`: not found or (`DRAFT` and not
  the owner) → 404; visible but not the owner → 403 `FORBIDDEN`. No `ADMIN`
  bypass.
- `PATCH /:id` only succeeds while `status === 'DRAFT'`; otherwise 409
  `AUCTION_NOT_EDITABLE`.
- `POST /:id/publish` only succeeds while `status === 'DRAFT'`; otherwise
  409 `AUCTION_NOT_PUBLISHABLE`. On success: `startTime` defaults to `now()`
  if neither the request nor the stored row has one; `endTime` must be
  resolvable from the request or the stored row, must be after `startTime`,
  and must be in the future.
- The repository's generic `updateAuctionRow` has no `status` field in its
  parameter type at all — only `publishAuctionRow` (and future
  start/pause/cancel/end equivalents) can change `status`.
- `reservePriceCents` supports an explicit `null` in a `PATCH` to clear an
  existing reserve, distinct from omitting the field (leave it alone) —
  verified empirically that Zod's `.partial()` preserves that distinction
  rather than assumed.
- Cross-field invariants (reserve ≥ starting price; `endTime` > `startTime`)
  are checked twice: a cheap Zod `.refine()` catches the case where both
  sides of a rule are in the same request body, and the service layer
  re-checks the *merged* result (patch fields as given, falling back to the
  already-stored row) before writing — because a `PATCH` touching only one
  side of a rule can't be validated against the other side by Zod alone.

## Why

- **The 404/403 split isn't a new rule — it's ADR-0008's rule applied to a
  new verb.** Visibility (can you know this exists) and authorization (can
  you act on it) are genuinely different questions, and mixing them up in
  either direction either over-shares or under-explains.
- **Status change unreachable by type signature, not just by validation**:
  even if a future bug let an unexpected field slip past the Zod schema,
  `updateAuctionRow`'s parameter type structurally has no `status` key —
  TypeScript itself, not just runtime validation, is a second line of
  defense for Section 82's "never trust client-controlled auction state."
- **Merged-value re-validation**: a schema-only check would let `PATCH
  {"reservePriceCents": 10}` through unchallenged against a stored
  `startingPriceCents` of `5000`, since the request alone contains no
  contradiction — the contradiction only exists once merged with the
  database row. Re-validating after the merge is the only place this can
  actually be caught.

## Tradeoffs

```text
DRAFT-only editing:
+ No fairness problem — a watched listing's terms can't shift after publish
- No way yet to fix a mistake in a published listing (no "unpublish", no
  edit-after-publish) — accepted gap, see Consequences

startTime defaults, endTime never does:
+ Removes real boilerplate for the common "publish now" case
+ Never silently invents the one number (auction duration) that's a real
  business decision
- Two different default behaviors for two fields on the same call is one
  more rule to remember when reading this code later (mitigated by the
  comment at the call site)
```

## Consequences

- No "unpublish" or "edit a published auction" path exists yet. If a seller
  makes a mistake after publishing, their only recourse today is `cancel`
  (not yet implemented) and re-listing. This is an accepted, temporary gap —
  Section 73's Phase 3 list has `cancel` as its own upcoming task, and
  deciding cancel's exact semantics now, speculatively, would be designing
  ahead of the actual task.
- `AUCTION_NOT_EDITABLE`/`AUCTION_NOT_PUBLISHABLE` are the first
  auction-specific error codes — establishes the naming convention future
  lifecycle actions (`start`/`pause`/`cancel`/`end`) should follow for their
  own "wrong state for this transition" errors.

## Revisit Conditions

- If real usage shows sellers frequently need to fix a published listing
  before any bid exists, that's a concrete, non-speculative reason to design
  an edit-after-publish or unpublish path — not before.
- Extend `requireOwnedAuction` with an admin bypass only if a real
  moderation requirement (not a hypothetical one) needs admin write access
  to listing content, separate from the account-moderation capability that
  exists today.
