import type { Consumer } from 'kafkajs';
import type { NotificationType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { logger } from '../../infrastructure/observability/logger';
import { pushNotification } from '../../infrastructure/realtime/notificationEvents';
import { env } from '../../config/env';
import { createConsumer, runConsumer, type MessageId } from '../../infrastructure/kafka/consumer';

// A distinct group id in tests — otherwise the test suite's consumer and a
// live `npm run dev` server's consumer (same Redpanda instance, same
// docker-compose) would join the SAME consumer group and rebalance
// partitions between two unrelated processes, causing exactly the kind of
// cross-talk/flakiness this distinction avoids. Same NODE_ENV-based-
// difference precedent as the rate limiters' test-vs-dev thresholds.
const GROUP_ID = env.NODE_ENV === 'test' ? 'notifications-consumer-test' : 'notifications-consumer';
const TOPICS = ['bid-events', 'auction-events', 'payment-events'];

type NewNotificationFromEvent = {
  userId: string;
  type: NotificationType;
  auctionId?: string;
  orderId?: string;
  data: Prisma.InputJsonValue;
};

// Idempotent by construction: `messageId` is Kafka's own (topic, partition,
// offset) — a redelivery of the same message always carries the same one
// (infrastructure/kafka/consumer.ts's doc comment). Notification's
// @@unique([sourceEventId, userId]) constraint turns a duplicate insert
// into a P2002 this catches and discards — the same P2002-as-idempotency-
// signal pattern bids/service.ts and payments/service.ts already use for
// their own races.
async function createNotificationIdempotently(messageId: MessageId, data: NewNotificationFromEvent): Promise<void> {
  try {
    const notification = await prisma.notification.create({
      data: { ...data, sourceEventId: messageId },
    });
    pushNotification(notification);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      logger.info({ messageId, userId: data.userId }, 'notification.idempotent_replay');
      return;
    }
    throw err;
  }
}

type BidOutbidPayload = {
  type: 'bid.outbid';
  auctionId: string;
  outbidUserId: string;
  previousAmountCents: number;
  newAmountCents: number;
};
type AuctionSoldPayload = {
  type: 'auction.sold';
  auctionId: string;
  orderId: string;
  buyerId: string;
  sellerId: string;
  amountCents: number;
};
type AuctionReserveNotMetPayload = {
  type: 'auction.reserve_not_met';
  auctionId: string;
  sellerId: string;
  highestBidCents: number | null;
  reservePriceCents: number | null;
};
type PaymentSucceededPayload = {
  type: 'payment.succeeded';
  orderId: string;
  auctionId: string | null;
  sellerId: string;
  amountCents: number;
};

type DomainEvent = BidOutbidPayload | AuctionSoldPayload | AuctionReserveNotMetPayload | PaymentSucceededPayload;

const KNOWN_EVENT_TYPES = new Set<DomainEvent['type']>([
  'bid.outbid',
  'auction.sold',
  'auction.reserve_not_met',
  'payment.succeeded',
]);

function isDomainEvent(payload: unknown): payload is DomainEvent {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    KNOWN_EVENT_TYPES.has((payload as { type?: DomainEvent['type'] }).type as DomainEvent['type'])
  );
}

// The single mapping from "a domain event happened" to "these Notification
// rows should exist" — exported and called directly by tests (no need to
// spin up a real subscribed consumer and wait on real message delivery to
// verify this mapping's logic; a small number of true end-to-end tests
// cover the real publish -> consume wiring separately).
export async function handleNotificationEvent(topic: string, _key: string | null, payload: unknown, messageId: MessageId): Promise<void> {
  if (!isDomainEvent(payload)) {
    throw new Error(`Unrecognized event payload on topic "${topic}": ${JSON.stringify(payload)}`);
  }

  switch (payload.type) {
    case 'bid.outbid':
      await createNotificationIdempotently(messageId, {
        userId: payload.outbidUserId,
        type: 'OUTBID',
        auctionId: payload.auctionId,
        data: { previousAmountCents: payload.previousAmountCents, newAmountCents: payload.newAmountCents },
      });
      return;

    case 'auction.sold':
      // Two notifications from one event — the compound
      // (sourceEventId, userId) unique constraint is exactly what makes
      // this safe: both inserts share a messageId but have different
      // userIds, so neither collides with the other, while a REDELIVERY of
      // this same message collides with both of its own earlier inserts,
      // as intended.
      await createNotificationIdempotently(messageId, {
        userId: payload.buyerId,
        type: 'AUCTION_WON',
        auctionId: payload.auctionId,
        orderId: payload.orderId,
        data: { amountCents: payload.amountCents },
      });
      await createNotificationIdempotently(messageId, {
        userId: payload.sellerId,
        type: 'AUCTION_SOLD',
        auctionId: payload.auctionId,
        orderId: payload.orderId,
        data: { amountCents: payload.amountCents },
      });
      return;

    case 'auction.reserve_not_met':
      await createNotificationIdempotently(messageId, {
        userId: payload.sellerId,
        type: 'AUCTION_RESERVE_NOT_MET',
        auctionId: payload.auctionId,
        data: { highestBidCents: payload.highestBidCents, reservePriceCents: payload.reservePriceCents },
      });
      return;

    case 'payment.succeeded':
      await createNotificationIdempotently(messageId, {
        userId: payload.sellerId,
        orderId: payload.orderId,
        type: 'PAYMENT_RECEIVED',
        ...(payload.auctionId ? { auctionId: payload.auctionId } : {}),
        data: { amountCents: payload.amountCents },
      });
      return;
  }
}

let consumer: Consumer | undefined;

export function startNotificationsConsumer(): void {
  if (consumer) {
    return;
  }
  consumer = createConsumer(GROUP_ID);
  void runConsumer(consumer, TOPICS, handleNotificationEvent).catch((err: unknown) => {
    logger.error({ err }, 'Notifications consumer failed to start');
  });
}

export async function stopNotificationsConsumer(): Promise<void> {
  if (!consumer) {
    return;
  }
  await consumer.disconnect();
  consumer = undefined;
}
