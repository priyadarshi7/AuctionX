import type { Consumer } from 'kafkajs';
import type { NotificationType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { emailSender } from '../../infrastructure/email/sender';
import { logger } from '../../infrastructure/observability/logger';
import { pushNotification } from '../../infrastructure/realtime/notificationEvents';
import { env } from '../../config/env';
import { deliveryCodeFor } from '../orders/deliveryOtp';
import { createConsumer, runConsumer, type MessageId } from '../../infrastructure/kafka/consumer';

// Backend only ever needs this for the two transactional emails below — the
// frontend has its own richer formatCents (apps/web/lib/format.ts) for
// actual UI display; not worth sharing a package for one line of logic.
function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// A distinct group id in tests — otherwise the test suite's consumer and a
// live `npm run dev` server's consumer (same Redpanda instance, same
// docker-compose) would join the SAME consumer group and rebalance
// partitions between two unrelated processes, causing exactly the kind of
// cross-talk/flakiness this distinction avoids. Same NODE_ENV-based-
// difference precedent as the rate limiters' test-vs-dev thresholds.
const GROUP_ID = env.NODE_ENV === 'test' ? 'notifications-consumer-test' : 'notifications-consumer';
const TOPICS = ['bid-events', 'auction-events', 'payment-events'];

// Carrier, tracking number and auction title are user-typed free text that
// ends up inside an HTML email body — escaped so a seller can't inject
// markup/links into a message that looks like it comes from AuctionX.
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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
// Returns whether this call actually inserted a new row (true) vs hit the
// idempotent-replay path (false) — callers that trigger a side effect
// beyond the DB/WebSocket, like sending an email below, need to know the
// difference: email sending isn't naturally idempotent the way the insert
// itself is, so a Kafka redelivery must not re-send one.
async function createNotificationIdempotently(messageId: MessageId, data: NewNotificationFromEvent): Promise<boolean> {
  try {
    const notification = await prisma.notification.create({
      data: { ...data, sourceEventId: messageId },
    });
    pushNotification(notification);
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      logger.info({ messageId, userId: data.userId }, 'notification.idempotent_replay');
      return false;
    }
    throw err;
  }
}

// Email is a pure enhancement on top of the in-app notification, same
// Section 24 reasoning as everything else in modules/ai — a failed send
// must never fail event processing (which would trigger Kafka redelivery,
// and this consumer has no DLQ handling of its own beyond what
// infrastructure/kafka/consumer.ts's generic retry gives it) or block the
// in-app notification (already committed by the time this runs) from
// existing.
async function sendTransactionalEmail(to: string, subject: string, html: string): Promise<void> {
  try {
    await emailSender.send({ to, subject, html });
  } catch (err) {
    logger.error({ err, to }, 'notification.email_send_failed');
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

type OrderShippedPayload = {
  type: 'order.shipped';
  orderId: string;
  auctionId: string;
  buyerId: string;
  sellerId: string;
  carrier: string;
  trackingNumber: string;
};
type OrderDeliveredPayload = {
  type: 'order.delivered';
  orderId: string;
  auctionId: string;
  buyerId: string;
  sellerId: string;
  // How delivery was completed (ADR-0045). Absent on events written before
  // the delivery-code flow existed.
  method?: 'OTP' | 'AUTO';
};

type OrderCancelledPayload = {
  type: 'order.cancelled';
  orderId: string;
  auctionId: string;
  buyerId: string;
  sellerId: string;
  amountCents: number;
  reason: string;
};

type AuctionModeratedPayload = {
  type: 'auction.moderated';
  auctionId: string;
  sellerId: string;
  action: 'pause' | 'resume' | 'cancel' | 'approve' | 'reject';
  reason: string | null;
};

type DomainEvent =
  | BidOutbidPayload
  | AuctionSoldPayload
  | AuctionReserveNotMetPayload
  | PaymentSucceededPayload
  | OrderShippedPayload
  | OrderDeliveredPayload
  | OrderCancelledPayload
  | AuctionModeratedPayload;

const KNOWN_EVENT_TYPES = new Set<DomainEvent['type']>([
  'bid.outbid',
  'auction.sold',
  'auction.reserve_not_met',
  'payment.succeeded',
  'order.shipped',
  'order.delivered',
  'order.cancelled',
  'auction.moderated',
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

    case 'auction.sold': {
      // Two notifications from one event — the compound
      // (sourceEventId, userId) unique constraint is exactly what makes
      // this safe: both inserts share a messageId but have different
      // userIds, so neither collides with the other, while a REDELIVERY of
      // this same message collides with both of its own earlier inserts,
      // as intended.
      const buyerNotified = await createNotificationIdempotently(messageId, {
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

      // Email only the buyer, and only for a genuinely fresh notification
      // (buyerNotified false means this is a Kafka redelivery — see
      // createNotificationIdempotently's doc comment). The seller already
      // gets their own email below when payment actually succeeds, which is
      // the moment that matters more for them than the sale itself.
      if (buyerNotified) {
        const [buyer, auction] = await Promise.all([
          prisma.user.findUnique({ where: { id: payload.buyerId }, select: { email: true } }),
          prisma.auction.findUnique({ where: { id: payload.auctionId }, select: { title: true } }),
        ]);
        if (buyer) {
          const itemLabel = auction ? `"${auction.title}"` : 'your item';
          await sendTransactionalEmail(
            buyer.email,
            "You won an auction on AuctionX!",
            `<p>Congratulations — you won ${itemLabel} for ${formatCents(payload.amountCents)}.</p><p>Visit <a href="${env.FRONTEND_URL}/orders">your orders</a> to complete payment.</p>`,
          );
        }
      }
      return;
    }

    case 'auction.reserve_not_met':
      await createNotificationIdempotently(messageId, {
        userId: payload.sellerId,
        type: 'AUCTION_RESERVE_NOT_MET',
        auctionId: payload.auctionId,
        data: { highestBidCents: payload.highestBidCents, reservePriceCents: payload.reservePriceCents },
      });
      return;

    case 'payment.succeeded': {
      const sellerNotified = await createNotificationIdempotently(messageId, {
        userId: payload.sellerId,
        orderId: payload.orderId,
        type: 'PAYMENT_RECEIVED',
        ...(payload.auctionId ? { auctionId: payload.auctionId } : {}),
        data: { amountCents: payload.amountCents },
      });

      if (sellerNotified) {
        const [seller, auction] = await Promise.all([
          prisma.user.findUnique({ where: { id: payload.sellerId }, select: { email: true } }),
          payload.auctionId
            ? prisma.auction.findUnique({ where: { id: payload.auctionId }, select: { title: true } })
            : Promise.resolve(null),
        ]);
        if (seller) {
          const itemLabel = auction ? `"${auction.title}"` : 'your item';
          await sendTransactionalEmail(
            seller.email,
            'Payment received on AuctionX',
            `<p>Payment of ${formatCents(payload.amountCents)} for ${itemLabel} has been confirmed.</p><p>Visit <a href="${env.FRONTEND_URL}/orders">your orders</a> for details.</p>`,
          );
        }
      }
      return;
    }

    case 'order.shipped': {
      const buyerNotified = await createNotificationIdempotently(messageId, {
        userId: payload.buyerId,
        type: 'ORDER_SHIPPED',
        orderId: payload.orderId,
        auctionId: payload.auctionId,
        data: { carrier: payload.carrier, trackingNumber: payload.trackingNumber },
      });
      if (buyerNotified) {
        const [buyer, auction] = await Promise.all([
          prisma.user.findUnique({ where: { id: payload.buyerId }, select: { email: true } }),
          prisma.auction.findUnique({ where: { id: payload.auctionId }, select: { title: true } }),
        ]);
        if (buyer) {
          const itemLabel = auction ? `"${escapeHtml(auction.title)}"` : 'your item';
          // The delivery code is derived, so it can be recomputed here instead
          // of travelling through Kafka (ADR-0045).
          const order = await prisma.order.findUnique({
            where: { id: payload.orderId },
            select: { id: true, deliveryOtpVersion: true },
          });
          const codeLine = order
            ? `<p>Your delivery code is <strong style="font-size:18px;letter-spacing:2px">${deliveryCodeFor(order.id, order.deliveryOtpVersion)}</strong>. Give it to the courier only when the parcel is in your hands. It is also on your order page.</p>`
            : '';
          await sendTransactionalEmail(
            buyer.email,
            'Your AuctionX order has shipped',
            `<p>${itemLabel} is on its way via ${escapeHtml(payload.carrier)} (tracking: ${escapeHtml(payload.trackingNumber)}).</p>${codeLine}<p>Follow it on <a href="${env.FRONTEND_URL}/orders/${payload.orderId}">your order</a>.</p>`,
          );
        }
      }
      return;
    }

    case 'order.cancelled': {
      // Both parties are told: the buyer lost the item for not paying, the
      // seller's item is unsold again. Same event, two rows; the compound
      // (sourceEventId, userId) key keeps a redelivery idempotent per user.
      const data = { amountCents: payload.amountCents, reason: payload.reason };
      await createNotificationIdempotently(messageId, {
        userId: payload.buyerId,
        type: 'ORDER_CANCELLED',
        orderId: payload.orderId,
        auctionId: payload.auctionId,
        data,
      });
      await createNotificationIdempotently(messageId, {
        userId: payload.sellerId,
        type: 'ORDER_CANCELLED',
        orderId: payload.orderId,
        auctionId: payload.auctionId,
        data,
      });
      return;
    }

    case 'auction.moderated': {
      // An admin took action on the seller's auction; they are told what and
      // why.
      await createNotificationIdempotently(messageId, {
        userId: payload.sellerId,
        type: 'AUCTION_MODERATED',
        auctionId: payload.auctionId,
        data: { action: payload.action, reason: payload.reason },
      });
      // A cancellation also voids everyone's bids, so each distinct bidder is
      // told. One row per bidder is safe under redelivery: the
      // (sourceEventId, userId) unique constraint absorbs replays.
      if (payload.action === 'cancel') {
        const bidders = await prisma.bid.findMany({
          where: { auctionId: payload.auctionId, bidderId: { not: payload.sellerId } },
          distinct: ['bidderId'],
          select: { bidderId: true },
        });
        for (const { bidderId } of bidders) {
          await createNotificationIdempotently(messageId, {
            userId: bidderId,
            type: 'AUCTION_MODERATED',
            auctionId: payload.auctionId,
            data: { action: 'cancel', reason: payload.reason, asBidder: true },
          });
        }
      }
      return;
    }

    case 'order.delivered': {
      // Both parties: the seller entered the buyer's code (or the fallback
      // fired), so each side gets a record that the order is complete
      // (ADR-0045). One row per user keeps a redelivery idempotent.
      const data = { method: payload.method ?? null };
      for (const userId of [payload.sellerId, payload.buyerId]) {
        await createNotificationIdempotently(messageId, {
          userId,
          type: 'ORDER_DELIVERED',
          orderId: payload.orderId,
          auctionId: payload.auctionId,
          data,
        });
      }
      return;
    }
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
