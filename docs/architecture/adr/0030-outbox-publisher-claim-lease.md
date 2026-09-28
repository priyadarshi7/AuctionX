# 0030 — Outbox publisher: claim-lease locking against concurrent workers

## Context

ADR-0029's own live verification found a real, pre-existing bug: a live
`npm run dev` API server left running while the full test suite ran
against the same shared dev Postgres instance (`PROGRESS.md`'s
already-tracked "Isolated test database" gap) produced two real test
failures — a duplicate OUTBID notification, and a closing-worker race.
Stopping the stray dev server before re-running the suite made both
disappear, confirming the cause rather than guessing at it.

## Problem

`infrastructure/jobs/outboxPublisherWorker.ts`'s `findUnpublishedOutboxEvents`
was a plain `SELECT ... WHERE "publishedAt" IS NULL`, with no row locking.
Two concurrent worker instances — any two processes running this same
2-second poll loop against the same Postgres, which is exactly what a live
dev server and a test run both do — could both select the SAME unpublished
row, both `producer.send()` it to Kafka, and both then call
`markOutboxEventPublished` (itself idempotent, so no error there). By the
time either write happened, Kafka already had TWO distinct messages
(different `(topic, partition, offset)` triples) for ONE logical event.
Every consumer's idempotency is keyed on that triple (ADR-0027) — a
genuinely duplicate message is, by design, treated as a genuinely new one,
so this reliably produced duplicate downstream effects (a second
notification, in the case that surfaced it).

## Options considered

**Hold a `FOR UPDATE` lock across the actual Kafka sends.** Rejected: the
whole batch is sent sequentially (preserving publish order — an existing,
deliberate choice), so this could hold Postgres row locks open for the
duration of up to 50 sequential network calls. Section 65 is explicit that
transactions should be short and their lock duration understood; this
would trade one concurrency bug for a real lock-contention problem under
any actual load.

**A separate "claim" step, released as soon as possible.** Chosen. A row's
`claimedAt` timestamp is stamped by a single, atomic
`UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING *`
— one round trip, and the lock is held only for that statement, not
across anything that follows. `SKIP LOCKED` specifically (not plain
`FOR UPDATE`) means a second concurrent caller doesn't block waiting for
rows the first one is mid-claiming — it just skips them and claims
whatever's actually free, which is the correct behavior for a job queue
(there's nothing to wait FOR — those rows aren't this worker's to have).

**What if the worker crashes after claiming but before publishing?**
A `claimedAt` with no accompanying `publishedAt` after a lease window
(`CLAIM_LEASE_MS = 30_000`, comfortably longer than a legitimate batch
should ever take, short enough to recover promptly) becomes reclaimable by
anyone again — `claimOutboxEvents`'s own `WHERE` clause includes
`"claimedAt" IS NULL OR "claimedAt" < now() - lease`. A NORMAL publish
failure (not a crash) releases its own claim immediately instead
(`releaseOutboxEventClaim`), so an ordinary transient error still retries
on the very next 2-second tick, exactly as it did before this fix — only a
process that never gets the chance to run its own `catch` block waits out
the full lease.

## Decision

- `schema.prisma`: `OutboxEvent.claimedAt DateTime?` (nullable, no
  backfill needed — this table's data is explicitly ephemeral/derived, per
  its own existing doc comment), and the index changed to
  `[publishedAt, claimedAt, createdAt]` to match the new query shape.
- `infrastructure/outbox/repository.ts`: `claimOutboxEvents(limit, leaseMs)`
  replaces `findUnpublishedOutboxEvents`; new `releaseOutboxEventClaim(id)`.
- `outboxPublisherWorker.ts`: `runOnce` claims before iterating, and
  releases a claim on send failure inside the existing per-event
  try/catch — no change to the surrounding retry/DLQ reasoning, which was
  already correct.

## Consequences

- Verified the mechanism directly, not just indirectly through tests: two
  SEPARATE `PrismaClient` connections (genuinely concurrent, not just two
  async calls sharing one connection) raced to claim the same row via
  `Promise.all`. Run 3 times: exactly one claimed it and the other got
  zero, every time.
- Verified the ORIGINAL failure scenario is actually fixed, not just the
  isolated mechanism: re-ran the full suite with a live `npm run dev`
  server running concurrently — the exact setup that produced the original
  two failures. 165/165 passing.
- Full suite clean on its own too (165/165), confirming no regression from
  the six repository functions now targeting a table with one more nullable
  column, or the worker's changed query shape.

## Revisit Conditions

- If `PROGRESS.md`'s tracked "Isolated test database" gap (Testcontainers)
  is ever closed, this locking is still correct and still worth keeping —
  it protects against ANY concurrent publisher instances, not just the
  dev-server-vs-test-suite case that happened to surface it. Multiple API
  instances in production (Section 44) would hit the identical race
  without it.
- `CLAIM_LEASE_MS` (30s) has no measured basis beyond "comfortably longer
  than a batch of 50 sequential sends should take" — revisit if a real
  batch size or Kafka latency ever makes that assumption wrong.
