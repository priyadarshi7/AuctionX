# 0008 — Auction Listing: Visibility Rules and Keyset Pagination

## Context

`GET /api/v1/auctions` and `GET /api/v1/auctions/:id` are the first read
endpoints in the system, and the first anonymous-friendly ones (Section 30
calls out auction browsing as high-traffic, no-login-required). Two problems
had to be solved before writing them: what a caller who isn't the seller is
allowed to see, and how pages of results are requested without corrupting
under concurrent writes.

## Problem 1 — Visibility

An `Auction` in `DRAFT` status (AUCTION-001/ADR-0007) is a seller's
work-in-progress: title, description, and price they haven't committed to
publishing yet. Nothing in the schema itself stops a plain `findMany`/
`findUnique` from returning it to anyone who asks.

## Problem 2 — Pagination correctness

This is a live marketplace: new auctions get created continuously while
someone is actively paging through "newest first" results. OFFSET-based
pagination (`SKIP n TAKE m`) has a real, non-hypothetical bug here: if 3 new
rows are inserted between a caller's page-1 and page-2 requests, page 2
(computed as "skip the first `limit` rows, take the next `limit`") now skips
or repeats rows relative to what the caller actually saw on page 1 — the
window shifted under them mid-scroll.

## Options Considered

### Visibility

1. **Hide DRAFT from everyone but the owner/admin** (chosen).
2. **Show everything to everyone** — rejected outright; a `DRAFT` auction is
   explicitly pre-publish (ADR-0007), and showing it before the seller
   chooses to publish defeats the point of the status existing.
3. **404 vs 403 for a hidden DRAFT on `GET /:id`** — chose 404 (indistinguishable
   from nonexistent), consistent with the enumeration-safety posture already
   used for password reset (ADR-0006): don't let the response shape confirm
   that a specific, unpublished id exists.

### Pagination

1. **OFFSET/LIMIT** — simplest to implement, but has the page-drift
   correctness bug described above on a feed that changes while being read.
2. **Keyset ("cursor") pagination on `(createdAt, id)`** (chosen) — each page
   request says "give me rows before this exact row," which is stable
   regardless of what's inserted elsewhere in the table. Requires a
   composite tiebreaker because `createdAt` alone isn't a strict total order
   (two rows can share a timestamp).
3. **`id`-only keyset (no `createdAt`)** — rejected: `id` is a random UUID
   (ADR-0002), so ordering by it alone would not present "newest first," the
   actual product requirement.

## Decision

- `DRAFT` auctions are visible only to their own seller or a user with the
  `ADMIN` role (Section 21's admin/fraud-review capability). Every other
  status (`PUBLISHED`/`ACTIVE`/`PAUSED`/`CANCELLED`/`ENDED`) is public — no
  enumeration-safety concern applies to them, unlike account existence in
  forgot-password; a marketplace's whole purpose is browsability.
- `GET /:id` on a hidden `DRAFT` returns `404`, identical to a nonexistent id.
- `GET /` on an explicit `status=DRAFT` filter from a non-owner returns an
  **empty page**, not an error — `DRAFT` is a legal enum value, the caller
  simply isn't authorized to see any matching rows, same as a filter that
  legitimately matches zero rows.
- List pagination uses an opaque, base64url-encoded `(createdAt, id)` cursor,
  not `?page=`/`?offset=`.
- Neither route requires authentication (`optionalAuthenticate` already runs
  globally in `app.ts`); handlers read `req.user` if present to decide
  visibility, and treat it as absent otherwise.

## Why

- **DRAFT visibility as a single reusable check** (`canSeeDraftsFor`): both
  the list and single-item handlers call the same function, so the rule
  ("owner or admin") can't drift between the two endpoints.
- **Empty page over 403 for a non-owner's `status=DRAFT` filter**: a 403
  would confirm "you're not allowed to see this specific thing," which is
  more information than necessary; an empty result set is indistinguishable
  from "no drafts exist," giving nothing away.
- **Keyset over OFFSET**: this isn't premature optimization (Section 62) —
  it's a correctness fix for a problem that exists at the current, small
  scale already: any test or manual walkthrough that creates auctions while
  paginating hits it immediately, not just at hypothetical future traffic.
- **`(createdAt, id)` not `id` alone**: preserves "newest first" as the
  actual ordering while still guaranteeing a strict total order via the id
  tiebreak — the UUID's randomness is irrelevant here; it's only ever
  compared to itself for tie-breaking, never given semantic meaning.
- **Opaque cursor, not raw `?after=<timestamp>&afterId=<uuid>`**: keeps the
  specific columns used for pagination an implementation detail we can
  change later without it being a breaking API contract change.

## Tradeoffs

```text
Keyset pagination:
+ Stable under concurrent inserts/deletes — no page drift
+ O(limit) per page regardless of how deep the caller has paged (no
  accumulating OFFSET cost)
- Cannot jump to an arbitrary page number ("go to page 14") — only
  forward-through-cursor navigation, which fits an infinite-scroll feed but
  not a numbered-page UI
- Slightly more application code than a bare SKIP/TAKE

DRAFT-hidden-by-default:
+ Matches the actual product requirement (a listing isn't public until
  published)
- One more branch of logic every future auction read path must remember to
  apply consistently (mitigated by centralizing it in canSeeDraftsFor)
```

## Consequences

- `middleware/validate.ts` gained `validateQuery`, distinct from
  `validateBody` — verified empirically that Express 5's `req.query` has no
  setter (a direct assignment silently no-ops rather than throwing or
  taking effect), so the parsed/coerced result is stashed on
  `req.validatedQuery` instead of overwriting `req.query`. Any future
  query-string validation in this codebase should use `validateQuery`, not
  attempt to replicate `validateBody`'s reassignment pattern.
- No new index added for this task. The existing `@@index([status])`
  (ADR-0007) serves single-status filters; the default "everything except
  DRAFT" listing sorts in memory after that filter at today's row counts.
  Deferred, not forgotten (Section 62: measure before optimizing) — revisit
  with a composite `(status, createdAt)` index once real query latency data
  says it's warranted.

## Revisit Conditions

- Add a composite `(status, createdAt)` index if listing latency actually
  degrades under real data volume — not before, per Section 62.
- If a numbered-page UI is ever genuinely required (not just requested
  speculatively), that needs a separate `?page=` code path or a hybrid
  approach — keyset pagination structurally cannot support "jump to page
  14."
