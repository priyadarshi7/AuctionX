# 0010 — Auction Start/Pause/Cancel

## Context

AUCTION-004 (ADR-0009) implemented `update` and `publish`. This task adds
the remaining Phase 3 lifecycle actions from Section 73's list that don't
depend on bidding existing: `start`, `pause`, `cancel`. `end` is
deliberately excluded — determining a winner requires the Bid module
(Phase 4), so a real "end" implementation belongs with the closing worker,
not here.

## Problem

Section 73 lists `pause` as a Phase 3 action but never lists a matching
"resume" — yet a paused auction obviously needs some way back to `ACTIVE`.
Separately, Section 21 mentions admin fraud review as a reason to intervene
in a live auction, raising the question of whether `pause` (and therefore
`start`) should be admin-accessible, not just seller-accessible.

## Options Considered

### The missing "resume" verb

1. **Invent an unlisted `resume` endpoint** — rejected: nothing in Section 73
   calls for it, and it would duplicate `start`'s logic (both just mean
   "make bidding possible again") under a different name.
2. **Let `start` serve both roles** (chosen) — `start` is valid from either
   `PUBLISHED` (first activation) or `PAUSED` (resuming). One endpoint, one
   piece of logic, matching the actual task list instead of adding to it.

### Admin involvement in pause

1. **Admin can pause/resume any auction** — matches Section 21's fraud-
   review mention, but nothing in the system today actually produces a
   fraud signal to act on (AI fraud detection is Phase 10, not built).
   Adding the capability now would be speculative.
2. **Seller-only, like update/publish** (chosen) — consistent with
   ADR-0009's decision not to extend admin's account-moderation role into
   listing content/lifecycle without an actual, current trigger for it.

### Which states `cancel` accepts

1. **Only `ACTIVE`/`PAUSED`** — treats cancellation as strictly an
   in-progress-auction concern.
2. **Any non-terminal state, including `DRAFT`** (chosen) — gives a seller a
   clean way to formally abandon a draft they've decided not to pursue,
   consistent with never hard-deleting an auction row (ADR-0007's
   `onDelete: Restrict` reasoning: it's a business record, not disposable).

## Decision

- `POST /:id/start`: valid from `PUBLISHED` or `PAUSED` → `ACTIVE`. Rejects
  with 409 `AUCTION_NOT_STARTABLE` from any other state. Additionally
  rejects with 409 `AUCTION_SCHEDULE_EXPIRED` if the auction's `endTime` has
  already passed — this is a state conflict, not a validation error, since
  the request itself (which has no body) contains nothing wrong.
- `POST /:id/pause`: valid only from `ACTIVE` → `PAUSED`. 409
  `AUCTION_NOT_PAUSABLE` otherwise.
- `POST /:id/cancel`: valid from `DRAFT`, `PUBLISHED`, `ACTIVE`, or `PAUSED`
  → `CANCELLED`, and sets `endedAt` to now. 409 `AUCTION_NOT_CANCELLABLE`
  from `ENDED` or already-`CANCELLED`.
- All three reuse `requireOwnedAuction` (ADR-0009) unchanged: no admin
  bypass, same 404 (invisible `DRAFT`, not owner) vs 403 (visible, not
  owner) split.
- None of the three take a request body.

## Why

- **`start` as dual-purpose activation/resume**: the state machine doesn't
  actually care *why* an auction is moving to `ACTIVE` — from the bidding
  system's perspective (Phase 4), `PUBLISHED→ACTIVE` and `PAUSED→ACTIVE`
  are the same event. Splitting them into two endpoints would be modeling a
  distinction that doesn't exist anywhere else in the system.
- **`AUCTION_SCHEDULE_EXPIRED` as 409, not 400**: this endpoint has no
  request body, so there is nothing to validate — the conflict is entirely
  about the auction's *existing* data versus the current time. Using 400
  here would misrepresent what's actually wrong.
- **`cancel` accepting `DRAFT`**: symmetry and a real, if minor, product
  need — the alternative is an ever-growing pile of abandoned drafts with
  no formal "I'm done with this" signal.

## Tradeoffs

```text
start-as-resume:
+ One endpoint, one code path, matches the actual task list
- A client reading only the route name ("start") has to know it also means
  "resume" — mitigated by the code comment at the STARTABLE_STATUSES
  definition, but still a naming compromise

No admin pause/cancel:
+ Consistent with ADR-0009 — no capability granted without a stated,
  current need
- If fraud detection (Phase 10) or manual moderation needs to halt a
  suspicious live auction before then, there is genuinely no way to do that
  yet except asking the seller — an accepted, temporary gap
```

## Consequences

- `end` remains unimplemented. An `ACTIVE`/`PAUSED` auction whose `endTime`
  passes without anyone calling `cancel` just sits there — there is no
  automatic closing worker yet (Section 17's closing workflow is Phase 4
  territory, gated on the Bid module existing to determine a winner).
- `AUCTION_NOT_STARTABLE`/`AUCTION_NOT_PAUSABLE`/`AUCTION_NOT_CANCELLABLE`
  continue the `AUCTION_NOT_<VERB>ABLE` naming convention started in
  ADR-0009, now covering every lifecycle action except `end`.

## Revisit Conditions

- Add an admin override for pause/cancel only once Phase 10's fraud
  detection (or an equivalent real moderation need) actually exists to
  trigger it — not speculatively now.
- The automatic "start at scheduled `startTime`" and "end at scheduled
  `endTime`" workers are explicitly deferred to Phase 4/5, where a real
  scheduling/worker infrastructure decision (polling vs. a job queue) can be
  made deliberately rather than bolted on here.
