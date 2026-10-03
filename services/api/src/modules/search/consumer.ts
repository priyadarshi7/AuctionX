import type { Consumer } from 'kafkajs';
import { findAuctionById } from '../auctions/repository';
import { logger } from '../../infrastructure/observability/logger';
import { env } from '../../config/env';
import { createConsumer, runConsumer, type MessageId } from '../../infrastructure/kafka/consumer';
import { SEARCH_EVENTS_TOPIC } from '../../infrastructure/kafka/topics';
import { deleteAuctionDocument, upsertAuctionDocument } from './repository';

// A distinct group id in tests, same reasoning as modules/notifications/
// consumer.ts's GROUP_ID — otherwise the test suite and a live `npm run
// dev` server would join the same consumer group on the same Redpanda
// instance and rebalance against each other.
const GROUP_ID = env.NODE_ENV === 'test' ? 'search-consumer-test' : 'search-consumer';

// A DEDICATED topic, deliberately not reusing 'auction-events' even though
// every trigger site for this event already publishes there for other
// reasons. modules/notifications/consumer.ts also subscribes to
// 'auction-events' and treats an unrecognized `type` as a poison message —
// that's the deliberate DLQ signal ADR-0027 built (and tests). Publishing
// this module's OWN event type onto that same topic would make every
// single reindex event get caught by that check and routed to
// auction-events-dlq, corrupting a signal that's supposed to mean "this
// specific message is actually malformed," not "a message meant for a
// different consumer." A dedicated topic keeps both consumers' "poison
// message" signal meaningful. Test-scoped (ADR-0031) for a SECOND reason
// on top of that: a live dev server's consumer, in its OWN group, still
// independently receives a full copy of every message on a topic a test
// run publishes to (consumer-group isolation alone doesn't prevent that)
// — this is what actually stops a live dev server from polluting the real
// OpenSearch index with test data, not just GROUP_ID above.
const TOPICS = [SEARCH_EVENTS_TOPIC];

type AuctionReindexPayload = { type: 'auction.reindex'; auctionId: string };

function isAuctionReindexPayload(payload: unknown): payload is AuctionReindexPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { type?: unknown }).type === 'auction.reindex' &&
    typeof (payload as { auctionId?: unknown }).auctionId === 'string'
  );
}

// Deliberately re-fetches the auction from Postgres rather than trusting
// fields carried in the event payload — the payload only ever carries
// `auctionId` (every publish site, see auctions/repository.ts and bids/
// repository.ts). This means the index can never drift from what the
// event SAID changed; it always reflects the auction's actual current
// state at reindex time, and a missed/duplicate/out-of-order event
// self-heals on the next one, since every reindex recomputes the full
// document from source of truth rather than applying a delta.
export async function handleSearchEvent(topic: string, _key: string | null, payload: unknown, _messageId: MessageId): Promise<void> {
  if (!isAuctionReindexPayload(payload)) {
    throw new Error(`Unrecognized event payload on topic "${topic}": ${JSON.stringify(payload)}`);
  }

  const auction = await findAuctionById(payload.auctionId);

  // DRAFT and PENDING_REVIEW are never publicly visible (ADR-0008, ADR-0041)
  // — must never be searchable.
  // A missing row can't happen today (no delete endpoint exists), but
  // `deleteAuctionDocument` is a safe no-op either way (`ignore: [404]`).
  if (!auction || auction.status === 'DRAFT' || auction.status === 'PENDING_REVIEW') {
    await deleteAuctionDocument(payload.auctionId);
    return;
  }

  await upsertAuctionDocument(auction);
}

let consumer: Consumer | undefined;

export function startSearchConsumer(): void {
  if (consumer) {
    return;
  }
  consumer = createConsumer(GROUP_ID);
  void runConsumer(consumer, TOPICS, handleSearchEvent).catch((err: unknown) => {
    logger.error({ err }, 'Search consumer failed to start');
  });
}

export async function stopSearchConsumer(): Promise<void> {
  if (!consumer) {
    return;
  }
  await consumer.disconnect();
  consumer = undefined;
}
