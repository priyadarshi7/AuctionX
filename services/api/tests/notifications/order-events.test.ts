import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/infrastructure/database/prisma';
import { handleNotificationEvent } from '../../src/modules/notifications/consumer';

// Calls the consumer's handler directly (no Kafka round trip) — the same
// approach the handler's own doc comment sanctions for testing the
// event -> Notification mapping. The Kafka-wired end-to-end path is covered
// separately by notifications.test.ts.
const runId = Date.now();
const emails: string[] = [];

async function makeUser(label: string) {
  const email = `test-order-events-${runId}-${label}@example.com`.toLowerCase();
  emails.push(email);
  return prisma.user.create({ data: { email, passwordHash: 'x', name: label, emailVerifiedAt: new Date() } });
}

const orderId = randomUUID();
const auctionId = randomUUID();

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { orderId } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});

describe('order lifecycle notifications', () => {
  it('order.shipped notifies the buyer only, with carrier and tracking, and is idempotent on redelivery', async () => {
    const buyer = await makeUser('buyer1');
    const seller = await makeUser('seller1');
    const messageId = `shipped-${randomUUID()}`;
    const event = {
      type: 'order.shipped',
      orderId,
      auctionId,
      buyerId: buyer.id,
      sellerId: seller.id,
      carrier: 'DHL',
      trackingNumber: 'TRK-9',
    };

    await handleNotificationEvent('payment-events', orderId, event, messageId);
    await handleNotificationEvent('payment-events', orderId, event, messageId);

    const rows = await prisma.notification.findMany({ where: { orderId, type: 'ORDER_SHIPPED' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(buyer.id);
    expect(rows[0]!.data).toEqual({ carrier: 'DHL', trackingNumber: 'TRK-9' });
  });

  it('order.delivered notifies the seller only', async () => {
    const buyer = await makeUser('buyer2');
    const seller = await makeUser('seller2');
    await handleNotificationEvent(
      'payment-events',
      orderId,
      { type: 'order.delivered', orderId, auctionId, buyerId: buyer.id, sellerId: seller.id },
      `delivered-${randomUUID()}`,
    );

    const rows = await prisma.notification.findMany({ where: { orderId, type: 'ORDER_DELIVERED', userId: { in: [buyer.id, seller.id] } } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(seller.id);
  });

  it('order.cancelled notifies both buyer and seller', async () => {
    const buyer = await makeUser('buyer3');
    const seller = await makeUser('seller3');
    await handleNotificationEvent(
      'payment-events',
      orderId,
      { type: 'order.cancelled', orderId, auctionId, buyerId: buyer.id, sellerId: seller.id, amountCents: 5000, reason: 'PAYMENT_TIMEOUT' },
      `cancelled-${randomUUID()}`,
    );

    const rows = await prisma.notification.findMany({ where: { orderId, type: 'ORDER_CANCELLED', userId: { in: [buyer.id, seller.id] } } });
    expect(rows.map((r) => r.userId).sort()).toEqual([buyer.id, seller.id].sort());
    expect(rows[0]!.data).toEqual({ amountCents: 5000, reason: 'PAYMENT_TIMEOUT' });
  });
});
