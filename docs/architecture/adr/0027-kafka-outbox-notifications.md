# 0027 — Kafka, the Outbox pattern, and moving Notifications off the critical path

## Context

Section 73's phase plan puts Kafka (Phase 7) before Payments (Phase 8) —
we built Payments, and later Notifications, first, out of necessity. Every
one of ADR-0023, 0025, and 0026 explicitly says "no Outbox/Kafka needed
yet, revisit when Phase 7 lands." This is that phase, landing after those
three, deliberately used as a real refactor target rather than a
standalone toy: Section 64's own latency-budget diagram shows
`Bid -> Outbox -> Kafka -> {Fraud, Notification, Analytics}`, meaning
Notification specifically belongs off the bid/closing/payment critical
path, not bolted on as a new, disconnected feature.

## Problem

Two related problems:

1. Bid placement, auction closing, and payment-webhook handling each
   currently do the FULL work of a notification (decide who to notify,
   insert the row) inline, inside their own already-loaded transactions —
   directly contradicting Section 64 ("avoid: Bid → … → Notification →
   …") and Section 10 (the critical path should stay small).
2. Nothing durable connects "a domain event happened" to "Kafka publishes
   it" — publishing directly from request-handling code risks exactly
   what Section 10/16 warn against: a transaction that rolls back after
   an event was already published, or a publish that fails after the
   transaction already committed.

## Options considered

**Which broker?**

Apache Kafka (even KRaft-mode, no separate Zookeeper) is a JVM process
with a real disk/memory footprint. This project's disk situation turned
out to be a false alarm for AuctionX specifically (the ~50GB "mystery"
was unrelated Docker images from other projects, resolved this session —
see PROGRESS.md), but a disk-constrained dev machine is still the
environment this runs on. **Redpanda** — a single ~400MB C++ binary,
verified with a real `docker pull` + start + `rpk cluster health` before
adopting it (same empirical-verification discipline as `s3mock`,
ADR-0022) — speaks the real Kafka wire protocol: same `kafkajs` client,
same topics/partitions/consumer-group semantics everything in CLAUDE.md's
Kafka sections describes. Chosen over real Kafka specifically for the
local-dev footprint; nothing about the application code is
Redpanda-specific.

**How deep does the refactor go?**

Two shapes were considered: add Kafka+Outbox as new, additive
infrastructure wired to some new, independent use case (lower risk,
touches nothing already shipped) versus actually moving the existing
Notification triggers (ADR-0026) onto it (matches CLAUDE.md's own
diagrams, but touches already-tested code in `bids/repository.ts`,
`auctions/repository.ts`, `payments/repository.ts`). Chose the deeper
refactor — the whole point of Section 64's diagram is that Notification
belongs on the async side, and an additive-only Kafka use case would have
been a contrived first example instead of the real, motivated one that
was sitting right there.

**How does a domain event become durably queued for Kafka, without
publishing directly from request-handling code?**

The Outbox pattern (Section 16): a new `OutboxEvent` table
(schema.prisma), written in the SAME transaction as the domain change it
describes — `bids/repository.ts`'s bid-acceptance transaction, `auctions/
repository.ts`'s closing transaction, `payments/repository.ts`'s webhook
transaction. A separate polling worker
(`infrastructure/jobs/outboxPublisherWorker.ts`, same shape as
`auctionClosingWorker.ts`) reads unpublished rows and publishes them.
Section 40: if Redpanda is unreachable, these rows just stay unpublished
and get retried indefinitely on the next scan — business transactions
(placing a bid, closing an auction, applying a payment) are entirely
unaffected either way.

**How does a consumer avoid processing the same event twice (Kafka is
at-least-once, Section 15)?**

Considered embedding a producer-generated event id in each payload, but
that has a chicken-and-egg problem (the id would need to exist before the
row that contains it does). Instead: Kafka's own `(topic, partition,
offset)` triple is a message's guaranteed-unique identifier, and a
redelivery of the same message always carries the same one — used
directly as `Notification.sourceEventId`
(`infrastructure/kafka/consumer.ts`'s `MessageId`). A duplicate insert
hits `Notification`'s `@@unique([sourceEventId, userId])` constraint
(compound, not a bare unique on `sourceEventId` — one event, like
`auction.sold`, legitimately produces two notifications, one per side)
and is caught as a P2002, the same idempotency-via-unique-constraint
pattern `bids/service.ts` and `payments/service.ts` already use for their
own races.

**What happens to a message the consumer can't process (a poison
message)?**

Section 43: one bad message must not block its partition forever.
`infrastructure/kafka/consumer.ts`'s `runConsumer` catches any handler
error, republishes the raw message to `{topic}-dlq`, and lets the
original offset advance. This was verified for real, not just by unit
test, during this task's own live-server verification: the production
consumer group's first-ever connection (`fromBeginning: true`) replayed a
backlog of stale test-session messages referencing already-deleted test
users, each one correctly failed with a foreign-key error and landed on
its topic's `-dlq` — confirmed via `rpk topic list` showing
`bid-events-dlq` etc. genuinely created — without crashing the consumer
or blocking real messages behind it.

## Decision

- `OutboxEvent` model + `infrastructure/outbox/repository.ts`
  (`createOutboxEventInTx`, mirroring `modules/notifications/
  repository.ts`'s now-removed `createNotificationInTx` — same pragmatic
  cross-module reach-in, Section 54).
- `infrastructure/jobs/outboxPublisherWorker.ts` — polls every 2s,
  batches of 50, sequential sends (preserves publish order).
- `infrastructure/kafka/{client,producer,consumer}.ts` — a `kafkajs`
  client/producer singleton (idempotent producing enabled — covers the
  network hop, NOT the same guarantee as the Outbox itself, which covers
  "did this event genuinely happen"; Section 15's instruction not to
  casually claim exactly-once applies to both halves separately), and a
  generic consumer runner with the DLQ behavior above.
- `modules/notifications/consumer.ts` — the domain-specific mapping from
  four event types (`bid.outbid`, `auction.sold`,
  `auction.reserve_not_met`, `payment.succeeded`) to Notification rows,
  idempotent via `sourceEventId`.
- Three topics: `bid-events`, `auction-events` (both keyed by
  `auctionId` — matches Section 15's example, ordering matters
  per-auction), `payment-events` (keyed by `orderId` — deliberately
  different from the Section 15 example, since payment ordering matters
  per-order, not per-auction).
- `bids/repository.ts`, `auctions/repository.ts`, `payments/repository.ts`
  no longer create `Notification` rows or call `pushNotification`
  directly — each now writes exactly one `OutboxEvent` in its existing
  transaction instead. `bids/service.ts` lost its post-commit
  `pushNotification` call entirely — nothing left to push once creation
  moved fully off this path (a genuine simplification, not just a
  refactor for its own sake).
- A distinct Kafka consumer group id in `NODE_ENV=test`
  (`notifications-consumer-test` vs. `notifications-consumer`) — found
  necessary when the test suite and a live `npm run dev` server sharing
  one group caused partition-rebalance cross-talk between two unrelated
  processes on the same Redpanda instance.

## Tradeoffs

- A notification is no longer visible the instant its triggering request
  returns — it now depends on the outbox publisher's next scan (up to
  2s) plus a real Kafka round-trip plus consumer processing. Verified
  live this stays well within a couple of seconds in practice; the
  frontend already polls/pushes for it regardless (ADR-0026), so this is
  invisible to the buyer/seller experience, just no longer synchronous
  under the hood.
- `fromBeginning: true` means a consumer group's first-ever connection
  replays a topic's FULL history — correct for not missing genuinely
  early events, but it's also what caused the stale-test-data DLQ storm
  described above. Real (non-test) deployments start with empty topics,
  so this only ever bites a long-lived local dev machine's own
  accumulated Redpanda data — accepted, since periodically wiping local
  dev topics (as done during this task's own verification) is a
  reasonable dev-environment reset, not a production concern.
- No retention/cleanup job for old, already-published `OutboxEvent` rows,
  or for the Redpanda topics' own retention — deferred (YAGNI) until
  table/topic growth is an actually measured problem at this project's
  scale, not a theoretical one.
- Producer idempotence + Outbox durability together give effectively-once
  delivery to a topic; consumer processing is at-least-once with
  idempotent handling — Section 15's explicit instruction not to
  casually claim "exactly once" is followed literally here: this system
  does NOT claim it, and the design accounts for redelivery rather than
  assuming it away.

## Consequences

- 165/165 tests passing (162 prior + 3 new: consumer idempotency on
  redelivery — both the single-notification and the two-notifications-
  from-one-event cases — and the "unrecognized payload throws" DLQ-
  routing signal). The existing `notifications.test.ts` suite was
  rewritten to poll for results instead of asserting immediately, since
  notification creation is now genuinely asynchronous.
- Verified live twice: once via the automated test suite against a real
  Redpanda instance (not mocked), and once via a full real-browser
  Playwright session — register/bid/outbid via curl, watch the
  notification bell update live with no page reload — proving the
  end-user-visible behavior from ADR-0026 is unchanged despite the
  underlying mechanism changing completely.
- Resolved, as a side effect of this task's own need for disk headroom
  before pulling Redpanda's image: the long-unexplained disk-space drain
  first flagged during the C:→D: project move. It was never AuctionX —
  ~50GB of unrelated Docker images (blender-render-*, pytorch, ollama)
  from other projects on the same machine. Freed via
  `docker image prune -a` + `docker builder prune -a`; the WSL2 VHDX file
  itself (`docker_data.vhdx`, confirmed at 66.39GB) doesn't auto-shrink
  when Docker's internal data shrinks, so the actual Windows-visible free
  space didn't recover — a separate, deliberately deferred step
  (`wsl --shutdown` + `diskpart compact vdisk`, needs admin + briefly
  stops all containers) the developer can run whenever convenient.

## Revisit conditions

- Extract a genuinely separate consumer process once there's a real
  reason to scale notification processing independently from the API
  (Section 4 — no such reason exists yet at one-instance scale).
- Add retention/cleanup for `OutboxEvent`/Redpanda topics once their
  growth is measured, not assumed.
- Revisit the partitioner/partition-count choice (currently one partition
  per topic, `KAFKAJS_NO_PARTITIONER_WARNING` silenced accordingly) if a
  topic's throughput ever actually needs more than one partition's worth
  of parallelism.
