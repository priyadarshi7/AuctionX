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

// Oldest-unpublished-first — see the model's own doc comment on why
// (delivery ordering after a broker outage recovers).
export function findUnpublishedOutboxEvents(limit: number): Promise<OutboxEvent[]> {
  return prisma.outboxEvent.findMany({
    where: { publishedAt: null },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
}

export function markOutboxEventPublished(id: string): Promise<OutboxEvent> {
  return prisma.outboxEvent.update({ where: { id }, data: { publishedAt: new Date() } });
}
