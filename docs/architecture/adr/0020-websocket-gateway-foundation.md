# 0020 — WebSocket Gateway Foundation

> **Amended by ADR-0021**: the mandatory-authentication design below
> (close code `4001`, the auth timeout) was found to conflict with a real
> requirement — anonymous public viewing (ADR-0008) — while wiring real
> events through this gateway, and was changed to optional authentication.
> The rest of this ADR's reasoning (placement, fanout model, heartbeat,
> shutdown) is unchanged. Kept here as the historical record of why the
> original design looked the way it did; see ADR-0021 for the correction.

## Context

Phase 6 (Section 73) is live bids, auction state changes, countdown updates,
winner announcements, and real-time notifications. Since WEB-002, the
frontend has stood in with a 5-second poll on the auction detail page
(ADR-0016) as an explicit, temporary substitute. This task builds the actual
mechanism: connection lifecycle, authentication, and a subscribe/fanout
model — deliberately with **no real event producer wired in yet**. Bid
placement and auction lifecycle transitions don't call into this gateway;
that's WS-002. This task only has to prove the plumbing itself is correct.

## Problem

Section 14 lists what a real WebSocket gateway has to get right: connection
lifecycle, authentication, reconnection, heartbeats, backpressure, fanout,
and — critically for later — that Redis Pub/Sub is not a durable event log.
None of that exists yet. Three concrete design questions had to be answered
before writing any code:

1. **Where does this run?** In-process with the Express API, or as a
   separate service?
2. **How does a WebSocket connection authenticate**, given the browser
   can't set custom headers on the handshake, and the access token lives
   only in memory on the client (never a cookie — ADR-0015)?
3. **How does a client express "send me updates for auction X,"** and how
   does the server route an event to exactly the right set of connections?

## Options Considered — placement

1. **A separate `ws-gateway` service** (Section 14's own diagram shows one)
   — rejected for now. Section 4 is explicit: extract a service only when
   there's a real scaling/failure-boundary reason. At one API instance and
   zero measured connection load, there is no such reason yet; a dedicated
   service today would be speculative infrastructure with an unjustified
   deployment/observability cost.
2. **In-process, attached to the same `http.Server`** (chosen) — the
   `WebSocketServer({ noServer: true })` pattern, hooked into the same
   server's `upgrade` event that `app.listen()` already returns. One
   process, one port, matching Section 4's "modular monolith first, extract
   later" instruction applied to a new subsystem instead of a new rule.

## Options Considered — authentication

1. **Access token in the `/ws?token=...` query string** — rejected. Query
   strings are far more likely than headers or message bodies to end up in
   proxy logs, CDN logs, or browser history — Section 34 says never log a
   token, and a query-string token defeats that even when application code
   itself never logs it directly.
2. **Rely on the httpOnly refresh cookie during the handshake** — rejected.
   That cookie is scoped to `/api/v1/auth` (ADR-0003) specifically so it
   isn't sent on unrelated requests; broadening its scope just to cover
   `/ws` would weaken a deliberate existing security boundary for this
   feature's convenience.
3. **Accept the upgrade unauthenticated; require an `auth` message with the
   access token as the client's first WebSocket message, within a timeout**
   (chosen) — the token travels inside the encrypted WebSocket payload
   (over `wss://` in production), never in a URL or a broadened cookie
   scope. A connection that doesn't send a valid `auth` message within
   `authTimeoutMs` (default 5s) is closed (code `4001`); an invalid/expired
   token closes with `4002`.

## Options Considered — subscribe/fanout model

1. **Broadcast every event to every connected client, let the client
   filter** — rejected outright: wasteful bandwidth for anyone watching one
   auction among thousands, and a specific violation of Section 46's "avoid
   unnecessary fanout" guidance for hot auctions.
2. **Per-auction rooms: client sends `subscribe`/`unsubscribe` with an
   `auctionId`; the server keeps an in-memory `Map<auctionId, Set<socket>>`
   and only sends to that room** (chosen) — a broadcast only ever reaches
   sockets that actually asked for that specific auction's updates.
   Deliberately in-memory and single-instance only: Section 14 already
   states Redis Pub/Sub fanout is required once there is more than one
   gateway instance for cross-instance broadcast, but that's unjustified
   infrastructure today at one instance (Section 4) — noted as a concrete,
   named revisit condition below, not silently punted.

## Decision

`infrastructure/websocket/gateway.ts`: `startWebSocketGateway(server,
options)` / `stopWebSocketGateway()` (module-singleton start/stop, same
shape as the existing `auctionClosingWorker.ts`), plus `broadcastToAuction
(auctionId, payload)` as the one function future callers (WS-002) will use.
Zod validates every inbound message against a discriminated union
(`auth`/`subscribe`/`unsubscribe`) — the same "validate everything crossing
a trust boundary" policy Section 28 already applies to HTTP bodies, applied
here to WebSocket messages instead.

Heartbeat: a 30s server-initiated `ping`; a connection that doesn't answer
with a `pong` before the next tick is `terminate()`d (not `close()`d — a
half-open connection won't complete a clean close handshake either). `ws`'s
client-side library answers pings automatically at the protocol level, no
application code required on the client.

Graceful shutdown: every open connection gets an explicit `1001` ("going
away") close frame before the underlying `WebSocketServer` itself closes,
and this happens *before* `server.close()` in `server.ts`'s shutdown
sequence (Section 69) — WebSocket connections are long-lived, not in-flight
HTTP requests waiting to finish, so there's no reason to wait for them.

## Why

- **The auth-timeout/first-message pattern keeps a real secret out of every
  place it would otherwise leak** (URLs, an over-broadened cookie), at the
  cost of one small custom handshake step instead of relying on the
  transport's own headers — a bounded, understood tradeoff, not a hidden
  weakening of the existing token model.
- **Per-auction rooms are the direct, minimal implementation of "avoid
  unnecessary fanout"** (Section 46) — every design alternative here was
  rejected specifically because it either wasted bandwidth or added
  infrastructure with no current justification, matching Section 62's
  "measure before optimizing, don't speculatively scale" instruction in
  reverse: don't speculatively add distributed infrastructure either.
- **In-process placement is the same "don't extract prematurely" judgment
  call already made for every other subsystem in this codebase** (Redis,
  the closing worker, everything) — applied consistently rather than special-
  cased for WebSockets just because Section 14's diagram happens to draw a
  separate box.

## Tradeoffs

```text
In-process WebSocket gateway (not a separate service):
+ Zero new deployment/observability surface
+ Consistent with every other "don't extract until justified" decision here
- Cannot scale WebSocket connection count independently of HTTP request
  throughput — a real limit, revisit once instance-level metrics (Section 33)
  show connection count, not request rate, is the actual bottleneck

First-message auth handshake (not a header/query param):
+ Token never appears in a URL, proxy log, or CDN log
+ No broadening of the existing refresh-cookie's deliberately narrow scope
- A few hundred milliseconds of "connected but not yet authenticated" state
  per connection, and one small custom protocol step a header-based
  approach wouldn't need

Single-instance, in-memory room map (no Redis Pub/Sub yet):
+ Zero new infrastructure dependency for this task
+ Correct and sufficient at today's one-instance scale
- Breaks the moment there is more than one API instance: a broadcast
  produced by whichever instance handled a bid would only reach clients
  connected to THAT instance, not clients connected to a different one —
  a real, named gap, not a hidden one (see Revisit Conditions)
```

## Consequences

- New dependency: `ws` (+ `@types/ws`). Chosen over Socket.IO specifically
  because Socket.IO's own framing/transport-fallback/rooms abstraction would
  hide exactly the mechanics (handshake, ping/pong, close codes) this
  project exists to teach directly; the room/broadcast logic actually
  needed here is small enough to own.
- `server.ts`: `startWebSocketGateway(server)` called right after
  `app.listen()`; `stopWebSocketGateway()` added to the shutdown sequence,
  before `server.close()`.
- **No wiring to real events yet** — `broadcastToAuction` exists and is
  tested directly, but nothing in `bids/service.ts` or
  `auctions/service.ts` calls it. The frontend's 5s poll (ADR-0016) stays in
  place until WS-002 replaces it; removing the poll now would leave the
  detail page with no live updates at all.
- Tests (`tests/websocket/gateway.test.ts`, all passing): auth-timeout
  close (`4001`), invalid-token close (`4002`), successful auth, rejecting
  subscribe/unsubscribe before authentication, fanout scoped correctly to
  only the subscribed room (a second client subscribed to a *different*
  auction is proven NOT to receive another auction's broadcast), unsubscribe
  actually stopping further delivery, a healthy connection surviving across
  a real heartbeat interval (proving the heartbeat wiring doesn't kill
  connections that respond normally), and every open connection receiving
  close code `1001` when the gateway stops. Fixed a real bug found while
  writing these tests: `stopWebSocketGateway` didn't remove its `upgrade`
  listener from the server, so a start→stop→start cycle (which every test
  needs, to verify start/stop is actually symmetric and not just "happens
  to work once per process lifetime") would stack duplicate listeners and
  double-process the same upgrade. Fixed by tracking and explicitly
  removing the specific listener on stop.
- **Verified live** against the real dev server (not just Jest's synthetic
  `http.Server`): registered/logged in a real user for a real access token,
  connected over a real `ws://` socket through the actual `app.listen()`
  server (Helmet/CORS/etc. all present, unlike the test harness), confirmed
  `auth.ok`, `subscribed`, `unsubscribed`, `INVALID_MESSAGE` on a malformed
  message, and `4002` on an invalid token — all against the real running
  process. **Not verified live**: a real OS-level `SIGTERM` triggering
  graceful shutdown — Windows' `process.kill()` from a different process
  doesn't deliver an emulated POSIX signal the way Linux does (Node's own
  documented behavior: cross-process signals on Windows unconditionally
  terminate rather than invoking a registered handler), so this specific
  demonstration isn't possible on this dev machine. The shutdown *code path*
  itself is exercised directly by the Jest test (`stopWebSocketGateway()`
  closes every connection with `1001`), and the `process.on('SIGTERM'/
  'SIGINT')` registration is pre-existing, already-verified code from
  TASK-000 — this task only added two calls inside it.

## Revisit Conditions

- Add Redis Pub/Sub fanout across gateway instances the moment there is
  more than one API instance running (Section 14 already names this as
  required, not optional, at that point) — until then, it would be
  unjustified infrastructure per Section 4.
- If connection count ever needs to scale independently of HTTP request
  throughput (measured via Section 33's WebSocket metrics — active
  connections, connection rate — not guessed), that's the concrete signal
  to revisit extracting a dedicated WebSocket Gateway service (Section 14's
  original diagram, Phase 12 territory).
- WS-002: wire `broadcastToAuction` to real events — bid acceptance
  (`bids/service.ts`), auction state transitions (`auctions/service.ts`),
  and the closing worker — and retire the frontend's ADR-0016 polling
  stand-in once live updates actually arrive.
