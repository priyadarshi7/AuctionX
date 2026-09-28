# 0001 — Start as a Modular Monolith

## Context

AuctionX will eventually need independently-scalable services (bidding is
latency-critical and write-heavy; search and analytics are read-heavy and can
tolerate staleness; AI valuation is slow and asynchronous). A "final"
microservices architecture is sketched in `CLAUDE.md` Section 4.

## Problem

Building 8+ services on day one means every request crosses a network
boundary before there is any real traffic, contention, or scaling data to
justify where those boundaries should be. It also means learning
distributed-systems failure modes (partial outages, retries, distributed
transactions) before the core domain logic — auction lifecycle, bid
concurrency — is even correct.

## Options Considered

1. **Microservices from day one** — matches the eventual target architecture,
   but adds network calls, service discovery, and distributed transactions
   before there's a single correct bid-processing flow to distribute.
2. **Single unstructured Express app** — fastest to start, but business logic
   tends to leak into route handlers and modules become tangled, making a
   later extraction into services much harder.
3. **Modular monolith** — one deployable process, but with hard internal
   module boundaries (auth, users, auctions, bids, payments, notifications)
   that mirror the eventual service boundaries.

## Decision

Start with a modular monolith (`services/api`), organized as
`src/modules/<domain>/{controller,service,repository,schema,routes}`. Each
module owns its own data access and does not reach into another module's
repository directly.

## Why

A modular monolith gives us:

- One deployable unit — no network calls, no partial-failure modes, no
  distributed transactions — while the domain logic (auction state machine,
  bid concurrency control, idempotency) is still being designed and proven
  correct.
- Module boundaries that already look like future service boundaries, so
  extraction later is "move this folder behind an API" rather than "figure
  out where the seams are."
- A single Postgres database for now, but with each module's tables treated
  as owned by that module — no module writes to another module's tables
  directly, even though they're in the same physical database.

## Tradeoffs

```text
Modular monolith:
+ Simple deployment, one process, one log stream
+ Fast local development (docker compose up, no service mesh)
+ Transactions can span modules when genuinely needed (e.g. bid + auction
  update in one commit)
- Cannot scale one module independently of the others yet (all of `services/api`
  scales as one unit)
- Discipline-dependent: nothing stops a developer from importing another
  module's repository directly except code review
- Eventually some of this will need to be re-cut into real services, which is
  real (but bounded) rework
```

## Consequences

- No inter-service network calls, gRPC, or API gateway yet — see ADR for
  when the Bid module or Auction module gets extracted, once there's a
  measured reason (Section 4 of `CLAUDE.md`: every extraction must answer
  data ownership, scaling profile, and failure boundary).
- Redis, Kafka, and WebSockets are introduced in later phases only when a
  concrete requirement (caching hot auction state, durable async events,
  live bid fanout) demands them — not preemptively.

## Revisit Conditions

Revisit this decision when:

- A specific module has a measurably different scaling profile than the
  rest (e.g. Bid module needs 10x the instances of the Notification module
  under load-test data).
- A module needs a different runtime/language for a measured, specific
  bottleneck (Section 6).
- Team ownership boundaries require independent deployability.
