import type { OutboxEvent, Prisma } from '@prisma/client';
import { prisma } from '../database/prisma';

export type NewOutboxEvent = {
  topic: string;
  key: string;
  payload: Prisma.InputJsonValue;
};

// Takes the CALLER's transaction client — every trigger site (bids/
// repository.ts, auctions/repository.ts, payments/repository.ts) writes
// this row inside its OWN existing transaction, alongside the domain
// change it reports, which is the entire point of the Outbox pattern
// (schema.prisma's OutboxEvent doc comment / ADR-0027): the event's
// existence is atomically consistent with whatever it describes actually
// having committed.
export function createOutboxEventInTx(tx: Prisma.TransactionClient, data: NewOutboxEvent): Promise<OutboxEvent> {
  return tx.outboxEvent.create({ data });
}

// Claim-lease pattern (schema.prisma's OutboxEvent.claimedAt doc comment):
// two concurrent outboxPublisherWorker instances against the same Postgres
// must never both send the same event to Kafka. `FOR UPDATE SKIP LOCKED`
// means a second concurrent caller simply skips rows the first one is
// mid-claiming, rather than blocking on them — exactly what's wanted here
// (grab whatever's actually free, not wait your turn for rows someone else
// already has). The transaction is intentionally tiny (SELECT + UPDATE
// only) — it commits (releasing the row locks) BEFORE any Kafka send
// happens, so a slow/stuck publish never holds a Postgres lock open
// (Section 65). `leaseMs` bounds how long a claim is honored: a crashed
// worker's claimed-but-never-published rows become reclaimable by anyone
// once the lease expires, so a hard crash mid-batch still self-heals
// without manual intervention.
export async function claimOutboxEvents(limit: number, leaseMs: number): Promise<OutboxEvent[]> {
  // A single atomic UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP
  // LOCKED) RETURNING * — the subquery's row locks apply before the outer
  // UPDATE touches them, so this is one round trip, not a separate
  // select-then-update pair (which would reopen the exact same race this
  // function exists to close, if anything ran between the two).
  return prisma.$queryRaw<OutboxEvent[]>`
    UPDATE outbox_events
    SET "claimedAt" = now()
    WHERE id IN (
      SELECT id FROM outbox_events
      WHERE "publishedAt" IS NULL
        AND ("claimedAt" IS NULL OR "claimedAt" < now() - (${leaseMs}::text || ' milliseconds')::interval)
      ORDER BY "createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `;
}

// A normal (non-crash) publish failure releases its own claim immediately,
// rather than making that specific event wait out the full lease before
// its own next scan can retry it (Section 41 — this is a transient-failure
// retry; leaving it claimed would turn a fast retry into a slow one for no
// reason, since the worker that just failed to publish it is right here,
// available to try again next tick).
export function releaseOutboxEventClaim(id: string): Promise<OutboxEvent> {
  return prisma.outboxEvent.update({ where: { id }, data: { claimedAt: null } });
}

export function markOutboxEventPublished(id: string): Promise<OutboxEvent> {
  return prisma.outboxEvent.update({ where: { id }, data: { publishedAt: new Date() } });
}
