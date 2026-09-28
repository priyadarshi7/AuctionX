# 0013 — Anti-Sniping Auction Extension

## Context

Section 18 describes the last piece of Phase 4's list: an auction ending in
under 30 seconds, with a valid bid arriving, should have its end pushed
back — the classic countermeasure against "sniping" (waiting until the
last possible second to bid, leaving no time for anyone else to respond).
Section 18 is explicit that server time is authoritative and that this must
be handled atomically, not left to client timers.

## Problem

Two things had to be decided that Section 18's diagram doesn't spell out:
how far into the auction's remaining time counts as "close enough" to
trigger an extension, and how far the new end should be pushed — relative
to the old scheduled end, or relative to the bid that triggered it. Then,
separately, where this logic runs so that "accept the bid" and "extend the
schedule" can't ever happen as two independent, non-atomic steps.

## Options Considered

### Extension basis

1. **Extend by a fixed increment added to the OLD `endTime`**
   (`endTime + windowMs`) — simple, but produces an inconsistent amount of
   actual response time depending on exactly when within the window the
   triggering bid landed (a bid at 29s left yields more total remaining
   time than a bid at 1s left, even though both are "sniping" attempts).
2. **Extend to exactly `windowMs` from the triggering bid's own arrival**
   (`now + windowMs`, chosen) — every valid late bid guarantees the SAME
   fixed response window (30s) from that bid's own moment, regardless of
   exactly how late within the trigger window it arrived.

### Where the decision and the write happen

1. **Compute the extension in the service layer, write it in a follow-up
   call** — rejected outright: this reintroduces exactly the kind of
   non-atomic "decide, then separately write" gap Section 18 warns against,
   and BID-002/ADR-0012 already established why that's unsafe under
   concurrency for the bid write itself.
2. **Compute and apply the extension inside the SAME transaction, under the
   SAME row lock, as accepting the bid** (chosen) — no window exists where
   the bid is accepted but the extension hasn't happened (or the reverse),
   because both are part of one commit.

### Extension cap

1. **Cap total extensions or extension count** — a real, known real-world
   problem (a sustained bidding war could in principle extend an auction
   indefinitely), but nothing in Section 18 or elsewhere in CLAUDE.md
   specifies what that cap should be, and inventing a number would be
   guessing at a policy, not implementing one.
2. **No cap** (chosen for now) — documented explicitly as a deliberate,
   accepted gap rather than a silent omission.

## Decision

- `modules/bids/antiSniping.ts` exports `ANTI_SNIPING_WINDOW_MS = 30_000`
  and a pure function `computeExtendedEndTime(currentEndTime, now)`: returns
  `null` if `currentEndTime - now >= windowMs` (nothing to do), otherwise
  returns `now + windowMs`.
- `placeBidTransactionally` (`modules/bids/repository.ts`) calls this
  function using the LOCKED auction row's `endTime` and the current
  timestamp, immediately after accepting the bid but before committing, and
  includes the result in the SAME `tx.auction.update` call that sets
  `currentPriceCents`.
- The bid-placement response includes `auctionExtended: boolean` so a
  client gets immediate feedback without a second round trip.
- A replay of an already-accepted bid (via either idempotency path,
  ADR-0011/0012) never reports a fresh extension — it describes something
  that already happened, not a new event.
- No cap on total extension count or duration exists yet.

## Why

- **`now + windowMs`, not `endTime + windowMs`**: guarantees the actual
  product property Section 18 is protecting — "anyone who wants to respond
  to the last valid bid gets a real, fixed window to do it" — rather than
  an amount that varies with exactly when the snipe attempt landed.
- **One transaction, one lock**: this task didn't need to invent any new
  concurrency mechanism. The auction row is already locked for the bid
  acceptance itself (ADR-0012); extending the schedule is just one more
  field in the same already-atomic write.
- **Pure `computeExtendedEndTime` function**: the actual anti-sniping RULE
  is trivially unit-testable (boundary conditions, "extend from now not
  from old end") without needing a database, a transaction, or a lock —
  only the atomicity requirement needs the transaction, not the arithmetic.

## Tradeoffs

```text
now + windowMs extension basis:
+ Consistent, predictable response window regardless of exactly when
  within the trigger window a bid lands
- An auction's total duration is no longer purely a function of its
  original schedule — a late bidding war can run well past the seller's
  originally chosen endTime, which is the entire point but is still worth
  stating plainly as a real behavior change, not hiding it

No extension cap:
+ Simple; doesn't guess at an arbitrary policy number
- An auction with a sustained, sub-30-second bidding war could in
  principle never end through this mechanism alone — an accepted,
  documented gap, not an oversight
```

## Consequences

- Anti-sniping is scoped to `endTime` alone — it never touches `status`, so
  an already-`ACTIVE` auction just keeps its schedule pushed out; nothing
  about the state machine (ADR-0009/0010) changes.
- This closes out every item on Section 73's Phase 4 list except `end`
  itself, which remains deliberately deferred (ADR-0010) pending a real
  closing worker — anti-sniping actually makes that worker's job clearer:
  it must repeatedly re-check `endTime` rather than compute it once, since
  this mechanism can keep moving it.

## Revisit Conditions

- Add a maximum total extension (a duration cap, or a maximum number of
  extensions) only if real usage shows unbounded extension is an actual
  problem — not speculatively now.
- If a future requirement wants different extension behavior for different
  auction categories or price tiers, that's a parameterization of
  `computeExtendedEndTime`, not a redesign — the function's signature
  already isolates the rule from the atomicity mechanism.
