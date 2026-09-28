# 0021 — Wiring Real Events Through the WebSocket Gateway

## Context

WS-001 (ADR-0020) built the WebSocket gateway's plumbing — connections,
auth, subscribe/unsubscribe rooms, heartbeat, graceful shutdown — but wired
it to nothing. This task connects it to the two things Phase 6 actually
needs to show live: bid acceptance and auction lifecycle transitions, and
retires the frontend's ADR-0016 5-second polling stand-in in favor of it.

## A correction to WS-001 before wiring anything: auth was wrong to require

While designing where to call the new event, it became clear WS-001's
mandatory "authenticate within 5 seconds or get disconnected" design
(`4001`) doesn't fit an actual, already-shipped requirement: `GET
/auctions/:id` is explicitly public (ADR-0008), and the frontend already
lets an anonymous visitor watch an `ACTIVE` auction's live price via the
polling this task is replacing. An anonymous viewer has **no access token
to send at all** — mandatory auth would have silently broken live updates
for exactly the users Section 1 names ("allow users to watch auctions," not
"allow logged-in users to watch auctions").

This wasn't caught in WS-001 because that task never had to reconcile the
gateway's design against a specific existing page's actual auth
requirements — it was pure plumbing, tested in isolation. Wiring it to a
real page surfaced the gap immediately.

### Options Considered

1. **Leave auth mandatory; have the frontend simply not connect for
   anonymous viewers** — rejected. That would mean anonymous visitors keep
   getting the OLD experience (a static price with no live updates) while
   removing the poll that used to at least eventually catch up — a net
   regression for a real, intended use case, not a neutral scope cut.
2. **Make auth optional: `subscribe`/`unsubscribe` work immediately; `auth`
   remains available for a client that has a token, but is never a gate**
   (chosen). Justified because nothing privileged happens over this
   channel — every message it carries is a contentless "something changed,
   go refetch over REST" signal (see below), and REST re-enforces its own
   visibility rules (ADR-0008) independently of anything this channel does.
   There is no security property gained by gating subscribe on identity
   when the channel itself reveals nothing.

### Decision

`gateway.ts` revised: the `authTimeoutMs` option, the auth timer, and close
code `4001` are removed entirely. `auth` is now processed whenever it
arrives, not gated to "before anything else." An invalid token still closes
the connection with `4002` — a client that bothers to identify itself
deserves a clear signal its token is bad — but this never blocks it from
subscribing anonymously. Test coverage updated to match: the old
"authenticates within timeout" and "rejects subscribe before auth" tests
are replaced with "allows subscribe/unsubscribe without ever
authenticating."

## Problem: what should the WebSocket payload actually carry?

### Options Considered

1. **Push the full updated auction (and/or bid) data over the socket** —
   rejected. This would mean maintaining a SECOND serialization of auction
   data alongside the REST endpoint's, with its own visibility rules
   (ADR-0008) to keep in sync by hand — exactly the kind of unjustified
   duplication Section 58 warns against for CQRS-shaped designs adopted
   without a real read/write divergence to justify them. Two independent
   serializers for the same resource WILL drift eventually.
2. **A contentless "this auction changed, go refetch" signal; the client
   invalidates its existing REST-backed cache and lets the normal fetch
   path run** (chosen) — the WebSocket's only job is to tell a subscribed
   client WHEN to refetch, not WHAT changed. REST remains the single place
   auction/bid data is shaped and gated, unchanged by this feature existing
   at all.

### Decision

`broadcastToAuction` payload: `{ type: 'auction.changed', auctionId, reason:
'bid' | 'lifecycle' }`. `infrastructure/realtime/auctionEvents.ts`'s
`notifyAuctionChanged(auctionId, reason)` is the one place that pairs this
broadcast with the existing cache invalidation
(`invalidateAuctionCache`, ADR-0017) — invalidating first, broadcasting
second, so a client that reacts to the signal by immediately refetching
can't land on the now-stale cache entry in the window before invalidation
would otherwise have run.

Called from the exact same six sites that already call
`invalidateAuctionCache` (CACHE-001): `bids/service.ts`'s `placeBid`
(unconditionally, including the idempotent-replay branch — the existing
precedent already accepts a redundant invalidation as harmless, so a
redundant signal to an empty or already-current room is equally harmless),
and `auctions/service.ts`'s `updateExistingAuction`/
`publishExistingAuction`/`startExistingAuction`/`pauseExistingAuction`/
`cancelExistingAuction`, plus the closing worker's actual-close branch.
Broadcasting from all six, not just the ones a subscriber currently cares
about, avoids a second "which call sites matter" list to keep in sync with
the first.

## Why

- **Optional auth matches the actual product requirement** (public
  browsing) instead of a security posture invented without checking what
  the channel actually needed protecting.
- **Signal-only payloads keep REST as the single source of truth for data
  shape and visibility**, at the cost of one extra round trip after the
  signal arrives — acceptable because this is a display-refresh path, not
  the bidding critical path (Section 64 stays satisfied: nothing about bid
  placement's own latency changed).
- **Reusing the exact same six call sites as CACHE-001** means "something
  changed here" has one authoritative list, not two lists that could
  silently diverge as new mutation sites get added later.

## Tradeoffs

```text
Optional (not mandatory) authentication:
+ Anonymous viewers get real live updates, matching what REST already allows
+ No security property was actually being provided by the old mandatory gate
- A future feature that DOES need to push privileged/personalized data over
  this channel will have to add its own authorization check at that point
  — deferred, not solved, by this decision (see Revisit Conditions)

Signal-only WebSocket payload (not full data push):
+ Zero duplicate serialization/visibility logic to maintain
+ REST's existing correctness (ADR-0008, caching, formatting) is reused as-is
- One extra network round trip (WS signal -> REST refetch) versus a payload
  that could have updated the UI immediately — a real, accepted latency
  cost, bounded to a display refresh, not bid acceptance itself
```

## Consequences

- `infrastructure/realtime/auctionEvents.ts` (new): `notifyAuctionChanged`.
- `infrastructure/websocket/gateway.ts`: auth relaxed to optional (see
  above); `broadcastToAuction`'s doc comment updated to point at its one
  real caller.
- `modules/bids/service.ts`, `modules/auctions/service.ts`,
  `infrastructure/jobs/auctionClosingWorker.ts`: their existing
  `invalidateAuctionCache` calls replaced with `notifyAuctionChanged`
  (cache invalidation behavior itself is unchanged, just now paired with a
  broadcast).
- `apps/web/lib/useAuctionSocket.ts` (new): connects to `${wsOrigin}/ws`
  (derived from the same `NEXT_PUBLIC_API_URL` `apiClient.ts` already uses,
  not a second env var), sends `auth` when a token is available (never a
  precondition), sends `subscribe`, and on `auction.changed` calls
  `queryClient.invalidateQueries` for the same two query keys
  (`['auctions','detail',id]`, `['auctions','bids',id]`) the old poll
  refetched. Reconnects on close with capped exponential backoff (2s → 4s →
  8s… capped at 30s) — Section 14 lists reconnection as a required concern,
  and a single dropped connection must not silently freeze the page's live
  updates for the rest of the session with no visible symptom.
- `app/auctions/[id]/page.tsx`: `refetchInterval` removed from both
  queries; `useAuctionSocket` called instead, gated on `status === 'ACTIVE'`
  — the identical condition the old poll used.
- Tests: `tests/websocket/gateway.test.ts` updated for optional auth (net:
  removed 2 tests whose premise no longer holds, added 1 proving anonymous
  subscribe/broadcast delivery). Full backend suite: 139/139.
- **Verified live in a real browser** (Playwright, reusing the pattern
  established in WEB-000/001/002): a real seller and bidder account, a
  real `ACTIVE` auction, an **anonymous** browser context (no login at all)
  viewing the detail page, a bid placed from a separate process (not the
  browser), and the anonymous viewer's displayed price changing from
  $10.00 to $25.00 with **no page reload** — proving both the event wiring
  and the anonymous-access decision work together, not just each in
  isolation.
- **A genuine, separate infrastructure finding surfaced during
  verification, unrelated to this task's code**: `docker exec
  auctionx-redis redis-cli DBSIZE` reports an empty, recently-restarted
  container (expected — ADR-0005's Redis has no volume), but the app's own
  `REDIS_URL=redis://localhost:6379` connection reaches a DIFFERENT,
  persistent Redis instance containing 67 unrelated keys (`bull:
  resourcex-jobs:*` BullMQ data from an apparently different project,
  plus stray test keys). Something other than this project's `docker
  compose` stack is also bound to port 6379 on this machine. Not
  investigated or fixed here — it didn't block this task (rate-limit keys
  were cleared directly through the same connection the app uses, the
  established precedent from WEB-002) — but flagged plainly for the
  developer, since it means AuctionX's cache/rate-limit data is currently
  commingled with an unrelated project's Redis data on this dev machine.

## Revisit Conditions

- If a future feature needs to push privileged or personalized data over
  this channel (not just a refetch signal), authentication changes from
  optional-metadata back to something that gates access to THAT specific
  message type — a per-message-type decision, not a reversal of this ADR's
  blanket policy for the current signal-only payload.
- If the extra REST round-trip after a WS signal is ever measured (not
  guessed) to matter for perceived responsiveness on a very hot auction,
  reconsider pushing minimal fields (e.g. just `currentPriceCents`) directly
  in the broadcast — a targeted optimization, not a wholesale move to full
  payload duplication.
- Investigate the port-6379 Redis mismatch found during this task's live
  verification — determine what else on this machine is bound to that
  port, before it causes a real, confusing cross-project data collision.
  **Resolved in ADR-0028**: root cause was a WSL2/Docker Desktop host-port
  collision, fixed by moving this project's Redis to host port 6380.
