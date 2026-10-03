# ADR-0041: Pre-publication review, private documents, trusted sellers

## Context

Until now a seller could publish and start their own auction in two clicks,
with nobody looking at it first. AuctionX positions itself around rare items,
where a convincing fake costs a buyer real money. The admin panel (ADR-0040)
could moderate a listing only after it was already live.

## Problem

1. How do we hold a listing for review without letting a seller bypass it?
2. A reviewer needs the seller's paperwork, which is sensitive.
3. Reviewing everything does not scale, but starting strict is the safe default.
4. A review takes time, and an auction's end time cannot burn down while it
   waits.
5. What does a review actually promise buyers?

## Options Considered

- **Review nothing, moderate afterwards** (eBay, Etsy, Vinted). Rejected for
  this product's positioning; kept as the relaxed end of the policy.
- **Review everything forever** (Catawiki, the auction houses). Right for a
  curated brand, but a permanent bottleneck.
- **Risk-based review.** Chosen: review by default, loosen per seller and per
  category.
- **Seller picks an end time at submission** vs **a duration.** An end time
  is eaten by the queue. Chosen: a duration; the clock starts at approval.
- **Documents in the public image bucket** vs **a private bucket with signed
  URLs.** Certificates carry names, addresses and serial numbers. Chosen:
  private.
- **Enforce review in the UI only** vs **on the server.** The existing
  `publish` and `start` endpoints would let anyone skip a UI-only gate.

## Decision

- New status `PENDING_REVIEW`, hidden from the public exactly like `DRAFT`
  (list, get-by-id, search indexing, AI valuation access). Visible to the
  seller and admins only.
- **One seller action: `POST /auctions/:id/submit {durationSeconds}`.** The
  server decides what it means: review required → `PENDING_REVIEW`; otherwise
  straight to `ACTIVE` with the clock starting now. The legacy `publish`
  endpoint now refuses with `REVIEW_REQUIRED` whenever review applies, so the
  gate cannot be bypassed by calling the API directly.
- **Policy is a pure function** (`reviewPolicy.ts`): with
  `AUCTION_REVIEW_MODE=untrusted` (the default), a listing is reviewed unless
  the seller is `trustedSeller` AND the category is low-risk. Watches, jewelry,
  art and coins are always reviewed and require at least one document. Nobody
  is trusted by default, so it starts as "review everything". Admins grant or
  revoke trust per seller (`PATCH /admin/users/:id/trusted`, audited).
  `AUCTION_REVIEW_MODE=off` restores the old behaviour (used by tests).
- **Approve** sets `ACTIVE`, `startTime = now`, `endTime = now + requested
  duration`. **Reject** returns the listing to `DRAFT` with the admin's reason,
  shown to the seller, who fixes and resubmits. Sellers can **withdraw** a
  pending submission to edit it. All transitions are guarded `UPDATE`s with the
  source state in the `WHERE` (ADR-0038's idiom), so approval racing a
  withdrawal or a second admin has exactly one winner; each writes an audit
  entry, a reindex event, and a seller notification via the existing outbox.
- **Documents** (`auction_documents`, up to 5, PDF/JPG/PNG/WebP, 10 MB) go to a
  separate bucket `S3_DOCS_BUCKET` via a presigned POST, are registered only
  after the API confirms with `HeadObject` that the object exists (the client's
  claimed size and type are never trusted), and are readable only by the
  seller and admins through 5-minute signed URLs. They are frozen once the
  listing is submitted, so approval covers exactly what was submitted.
- **Wording.** The UI says a listing's details and documents were reviewed. It
  explicitly does not claim the item is authentic, and the reviewer UI tells
  admins they are checking plausibility and consistency, not certifying.
- **Closed a related hole:** the seller's `start` endpoint doubled as "resume",
  so a seller could lift a moderator's pause. A new `heldByAdmin` flag, set on
  admin pause and cleared on admin resume/cancel, blocks that
  (`AUCTION_HELD_BY_ADMIN`).

## Why

Server-side enforcement is the only version of a gate that holds. A duration
rather than an end time keeps sellers whole when review is slow. A pure policy
function with a per-seller trust flag lets the process loosen with evidence
instead of a redesign. Private storage matches the sensitivity of what is
uploaded.

## Tradeoffs

- Sellers wait for a human. With one admin, the queue is a real bottleneck and
  a slow review costs a seller their timing. There is no SLA or reminder yet.
- A reviewer reading photos and PDFs cannot prove an item is genuine. Review
  reduces obvious fraud; it does not eliminate it, and the wording avoids
  implying otherwise.
- Documents that are deleted from an auction leave no trace of a "removed"
  state for the reviewer; objects left behind by a cascade delete (account
  deletion) stay in the private bucket as orphans.
- The "max 5 documents" check is a soft limit under concurrent uploads.
- Bidders on an admin-cancelled auction are still not notified (ADR-0040).
- The documents bucket's privacy is deployment configuration. Locally, s3mock
  does not enforce signatures, so tests prove a link is signed and short-lived,
  not that an unsigned request is refused.

## Consequences

Every new listing, by default, waits for an admin. Trusted sellers and
low-risk categories can skip that without code changes. Existing live auctions
are untouched.

## Revisit Conditions

- A queue SLA, reminder emails to admins, or auto-escalation if the queue ages.
- Risk signals beyond category and trust: seller account age, starting price,
  AI valuation outliers, fraud scores (CLAUDE.md Section 21).
- Notify bidders when an admin cancels an auction that has bids.
- Virus scanning for uploaded documents.
- Re-review when a live listing is materially edited (editing live listings is
  not allowed today).
- If `AUCTION_REVIEW_MODE` is ever needed per environment at runtime without a
  redeploy, move it to a settings table.
