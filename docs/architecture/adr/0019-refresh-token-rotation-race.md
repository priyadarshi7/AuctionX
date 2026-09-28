# 0019 — Closing the Refresh-Token Rotation Race

## Context

ADR-0016 found a real bug while manually verifying WEB-002's bidding UI: a
freshly-logged-in user's session vanished after two near-simultaneous
`/auth/refresh` calls presented the same pre-rotation cookie. ADR-0016
fixed the *frontend* trigger (a `useRef` guard on `SilentRefresh`, closing
the React Strict Mode double-invocation that surfaced the bug) but
explicitly deferred the underlying *backend* race — the same two-tabs
scenario is still reachable in production, just less likely to occur by
accident — as its own task with its own concurrency test. This is that
task.

## Problem

`refreshTokens()` (pre-fix) did, as separate steps:

```text
1. findRefreshTokenByHash(hash)        <- unlocked read
2. check revokedAt / expiresAt         <- decision made from step 1's data
3. findUserById                        <- unlocked read
4. rotateRefreshToken (own transaction: create new + revoke old)
```

Step 1's read and step 4's write are separated by a network round trip
with nothing holding the row still in between. Two concurrent requests
presenting the *same* token can both execute step 1 before either commits
step 4, so both see `revokedAt: null` and both proceed to rotate:

```text
Request A: read (revokedAt=null) -> rotate -> creates token B, revokes A
Request B: read (revokedAt=null) -> rotate -> creates token C, revokes A
```

Nothing in the schema stops this — there's no unique constraint on "which
token replaces A." Both writes commit. The result is one token silently
forked into **two live, undetected sessions** (B and C), each belonging to
a different in-flight response. This is strictly worse than what was
actually observed in ADR-0016 (request B getting rejected with
`REFRESH_TOKEN_REUSED`) — that outcome only happened because request A's
DB round trip happened to finish before request B's read ran. Under
different timing, the fork goes through with no error to either caller and
no signal that reuse detection (ADR-0004) was supposed to catch this.

This is the identical shape of bug BID-002 hit and fixed (ADR-0012): a
check-then-act sequence split across a network round trip, racing against
a concurrent identical request on the same row.

## Options Considered

1. **Leave it, rely on the frontend guard** — rejected. ADR-0016's `useRef`
   fix only prevents one component instance from firing the call twice; it
   does nothing for two separate tabs, or any other client, refreshing at
   nearly the same moment. The race is a backend correctness gap, not a
   frontend one.
2. **Redis-based distributed lock on the token hash** — rejected. This is
   single-Postgres contention on a row that is already the source of
   truth; a distributed lock would add a new failure mode (Redis
   unavailable) to the security-critical auth path for no benefit over a
   plain row lock, since there is only one Postgres instance to coordinate
   against.
3. **`SELECT ... FOR UPDATE` inside one transaction covering the whole
   check-then-rotate sequence** (chosen) — the same mechanism ADR-0012
   already established for bid placement, applied to the same class of
   problem.

## Decision

Collapsed the entire refresh sequence — lock the token row, check
`revokedAt`/`expiresAt`, check the user is still `ACTIVE`, and either
revoke the family (reuse) or create+revoke (rotation) — into one
`prisma.$transaction`, with the token row locked via raw-SQL
`SELECT ... FOR UPDATE` for its full duration
(`consumeRefreshToken` in `modules/auth/repository.ts`).

Whichever concurrent request acquires the lock first now always commits
its rotation. The other blocks until the lock is released, then re-reads
the row *after* the winner's write is visible — so it deterministically
observes `revokedAt` already set and takes the reuse-detection path. The
fork is no longer possible; the outcome is always "one winner, one
reuse-detected loser," never "two winners."

The user's `ACTIVE` status check moved inside the same transaction too —
not for a locking reason (the `User` row isn't the contended resource
here), but so a disabled account can never end up with a fresh token pair
issued from a decision made on stale data.

## Why

- **Turns a nondeterministic security gap into a deterministic, already-
  accepted tradeoff.** ADR-0004 already documents that a legitimate
  lost-response retry will trip reuse detection and log the user out —
  that was an accepted cost, but only meaningfully accepted if it's the
  *only* way this situation resolves. Before this fix, the same trigger
  could instead silently fork a session with no error at all, which was
  never an accepted outcome, just an unnoticed one.
- **Matches established precedent instead of inventing a new mechanism**:
  ADR-0012 already solved the identical problem shape (check-then-act
  across a network round trip, same-row contention) for bid placement.
  Reusing that exact pattern here means the codebase now has one
  consistent answer to "how do we serialize a contended read-then-write,"
  not two different ones.
- **A DB row lock, not a new coordination layer**: this contention exists
  entirely within Postgres already holding the authoritative row; adding
  Redis or another lock service would introduce a dependency and a new
  failure mode into the auth path without removing any of the actual risk.

## Tradeoffs

```text
SELECT ... FOR UPDATE on the token row, one transaction end-to-end:
+ Closes the silent-session-fork hole entirely — verified by a real
  concurrent test, not just reasoned about
+ Reuses an already-established, understood pattern (ADR-0012) rather than
  a new one
+ No new infrastructure dependency
- Two legitimate, near-simultaneous refreshes (multi-tab) will now ALWAYS
  deterministically log the user out via REFRESH_TOKEN_REUSED, instead of
  "usually, depending on timing" — this is the same false-positive ADR-0004
  already accepts, now guaranteed rather than probabilistic. Still an open,
  documented UX gap, not silently reintroduced.
- One extra DB round trip's worth of lock-hold time per refresh under
  genuine concurrent contention on the SAME token (negligible: refresh
  happens roughly once per access-token TTL per active session, and only
  concurrent same-token refreshes ever contend with each other — different
  users' refreshes never touch the same row)
```

## Consequences

- `modules/auth/repository.ts`: `rotateRefreshToken` and `revokeTokenFamily`
  removed (no longer used, and keeping them around as dead code would
  invite a future caller to reintroduce the exact race this ADR closes);
  replaced by `consumeRefreshToken`, which owns the full locked
  transaction and returns a discriminated result (`not_found` / `reused` /
  `expired` / `account_disabled` / `rotated`).
- `modules/auth/service.ts`: `refreshTokens` now generates the candidate
  new token upfront (cheap, discarded if unused) and calls
  `consumeRefreshToken` once, translating its discriminated result into
  the same error codes as before — no change to the public API or error
  contract.
- **Verified, not just implemented**: `tests/auth/refresh.test.ts` gained a
  test that fires two refresh requests at the same pre-rotation token via
  `Promise.all` (real concurrent transactions, not sequential calls that
  merely look concurrent) and asserts the full invariant: exactly one
  request gets `200`, the other gets `401 REFRESH_TOKEN_REUSED`, and the
  winner's own newly-issued token is *also* dead immediately afterward —
  proving the whole family was revoked, not just that the loser failed.
  Run repeatedly to check for flakiness inherent to testing a real race;
  passed consistently. Full suite: 132/132 passing (131 prior + this one).

## Revisit Conditions

- If the multi-tab false-positive logout becomes a measured support/UX
  problem (not hypothetical), reconsider ADR-0004's already-documented
  option: a short grace window allowing the immediately-previous token for
  a few seconds post-rotation, rather than weakening this fix.
- If refresh volume on a single hot token ever becomes high enough for
  lock contention itself to matter (extremely unlikely — this is bounded
  by one legitimate user's own tabs, not general traffic), that would be a
  measured-first, not speculative, follow-up.
