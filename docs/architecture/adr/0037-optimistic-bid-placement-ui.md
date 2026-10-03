# ADR-0037: Optimistic bid placement in the frontend

## Context

After the Singapore move and the round-trip reduction (ADR-0036), an
accepted bid takes ~0.8s end to end, measured live. Most of that is
physics: the client's distance to Render in Singapore plus ~9 sequential
~60ms hops from the API to Postgres/Redis. The server path can't realistically
get under a few hundred ms on free-tier infrastructure.

## Problem

The user wants bidding to feel instant ("in fraction of seconds"). With the
current UI, nothing changes on screen until the server has responded.

## Options Considered

1. **Keep optimizing the server path.** Remaining levers (merge the two
   rate-limit Redis calls, collapse the transaction into one SQL statement,
   same-region database) save at most ~250ms combined, the last two with
   real correctness risk or cost. None reaches "instant".
2. **Optimistic UI.** On submit, immediately show the new price and a
   "Placing…" entry in the bid history, then reconcile with the server.
3. **Websocket-based bid submission.** Removes HTTP overhead only; the
   server-side hops and distance remain. Large change for a small gain.

## Decision

Option 2, in `BidForm.tsx` (React Query cache manipulation, no new
dependency): cancel in-flight fetches for the auction's detail and bids
queries, snapshot them, write the optimistic price and a pending bid
(`makeOptimisticBid`, id prefixed `optimistic-`), then:

- **success** -> invalidate both queries; the server's real data replaces the
  guess (real bid id/timestamp, plus any bids that landed meanwhile);
- **failure** -> restore the snapshots, invalidate to refetch the truth, and
  show the server's error (too low, auction ended, email not verified, ...).

The server remains the only authority (Section 9/10/82). The UI never claims
more than it knows: a pending bid is rendered as "Placing…", is never marked
"Leading", and does not trigger the "You're the highest bidder" notice until
the server confirms.

## Why

It is the only option that changes what the user *perceives* rather than what
the server *does*; the server work is unchanged, so no correctness risk to
the bid path. Idempotency is unaffected: the same per-click key is sent.

## Tradeoffs

- A bid that is going to be rejected (outbid in the meantime, auction ended)
  now flashes as placed and then rolls back with an error, instead of failing
  after a wait. Rejections are the minority case but they are slightly more
  jarring. The "Placing…" badge and the unchanged "Leading"/notice logic limit
  how misleading the intermediate state is.
- A websocket "auction changed" refetch that lands while the request is in
  flight can briefly replace the optimistic price with the server's older
  value (the server hasn't committed yet) before the real one arrives.
  Cosmetic; settles on the confirming refetch.
- The submit button still reads "Placing bid…" and stays disabled until the
  server answers, so double-submits remain impossible.
- No frontend test runner exists in the project; the cache update/rollback
  logic was verified against the real React Query library in a throwaway
  script, not by an automated test, and not yet exercised in a browser.

## Consequences

The price and history update at click time. Perceived latency of a bid drops
to ~0; actual confirmation latency is unchanged (~0.8s).

## Revisit Conditions

- If rejection rate is high in practice (hot auctions), consider showing the
  pending state more conservatively (e.g. only price, not the history row).
- If a frontend test setup is added (Vitest + Testing Library or Playwright),
  cover submit -> optimistic -> confirm and submit -> optimistic -> rollback.
