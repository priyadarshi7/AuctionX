import type { Consumer } from 'kafkajs';
import { findAuctionById } from '../auctions/repository';
import { logger } from '../../infrastructure/observability/logger';
import { env } from '../../config/env';
import { createConsumer, runConsumer, type MessageId } from '../../infrastructure/kafka/consumer';
import { AI_VALUATION_EVENTS_TOPIC } from '../../infrastructure/kafka/topics';
import { ollamaValuationProvider } from '../../infrastructure/ai/ollamaValuationProvider';
import { markValuationComplete, markValuationFailed } from './repository';

// Same test-scoping reasoning as modules/search/consumer.ts's GROUP_ID.
const GROUP_ID = env.NODE_ENV === 'test' ? 'ai-valuation-consumer-test' : 'ai-valuation-consumer';
const TOPICS = [AI_VALUATION_EVENTS_TOPIC];

type AuctionValuatePayload = { type: 'auction.valuate'; auctionId: string };

function isAuctionValuatePayload(payload: unknown): payload is AuctionValuatePayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { type?: unknown }).type === 'auction.valuate' &&
    typeof (payload as { auctionId?: unknown }).auctionId === 'string'
  );
}

// Deliberately catches EVERY failure internally and writes a FAILED
// valuation, rather than throwing and letting infrastructure/kafka/
// consumer.ts's generic DLQ handling take it — a real divergence from
// modules/search/consumer.ts's handleSearchEvent, worth being explicit
// about (ADR-0032): nothing in this project currently consumes or inspects
// any `-dlq` topic, so a message landing there today is effectively a
// silent dead end. A FAILED status the seller can actually see (and retry
// via POST .../valuation/regenerate) is a strictly better failure mode for
// an enhancement feature than an invisible one. This is safe specifically
// BECAUSE valuation is non-critical (Section 24) — the equivalent choice
// would be wrong for, say, a payment webhook.
export async function handleAiValuationEvent(
  topic: string,
  _key: string | null,
  payload: unknown,
  _messageId: MessageId,
): Promise<void> {
  if (!isAuctionValuatePayload(payload)) {
    logger.warn({ topic, payload }, 'ai.valuation.unrecognized_payload_ignored');
    return;
  }

  const auctionId = payload.auctionId;

  try {
    const auction = await findAuctionById(auctionId);
    if (!auction) {
      // The auction was created and then, hypothetically, is gone by the
      // time this event is processed — nothing to value. Not an error.
      return;
    }

    const result = await ollamaValuationProvider.valuate({
      title: auction.title,
      description: auction.description,
      category: auction.category,
      condition: auction.condition,
      imageUrls: auction.images,
    });

    await markValuationComplete(auctionId, result);
    logger.info({ auctionId, model: result.model }, 'ai.valuation.complete');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, auctionId }, 'ai.valuation.failed');
    try {
      await markValuationFailed(auctionId, message);
    } catch (persistErr) {
      // The AuctionValuation row may not exist (a pre-existing auction
      // whose lazy-backfill upsert on GET raced with this — see
      // service.ts) — logged, not re-thrown, since there's nothing further
      // to do here either way.
      logger.error({ err: persistErr, auctionId }, 'ai.valuation.failed_to_record_failure');
    }
  }
}

let consumer: Consumer | undefined;

export function startAiValuationConsumer(): void {
  if (consumer) {
    return;
  }
  consumer = createConsumer(GROUP_ID);
  void runConsumer(consumer, TOPICS, handleAiValuationEvent).catch((err: unknown) => {
    logger.error({ err }, 'AI valuation consumer failed to start');
  });
}

export async function stopAiValuationConsumer(): Promise<void> {
  if (!consumer) {
    return;
  }
  await consumer.disconnect();
  consumer = undefined;
}
