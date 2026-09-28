import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { runOnce as runClosingWorkerOnce } from '../../src/infrastructure/jobs/auctionClosingWorker';
import { runOnce as runOutboxPublisherOnce } from '../../src/infrastructure/jobs/outboxPublisherWorker';
import { connectProducer, disconnectProducer } from '../../src/infrastructure/kafka/producer';
import { startNotificationsConsumer, stopNotificationsConsumer } from '../../src/modules/notifications/consumer';

const app = createApp();

// Kafka consumer group join/rebalance (kafkajs's own protocol overhead) can
// genuinely take a few real seconds on a cold start — well past Jest's
// default 5000ms per-test timeout, which would otherwise fail a slow-but-
// correct test rather than a broken one.
jest.setTimeout(20_000);

// Real Kafka pipeline for this whole file, not mocked — same "test against
// real infra" precedent as Postgres/Redis/s3mock elsewhere in this
// project. Started at module load (not inside beforeAll) so connection
// setup overlaps with the first few tests' own register/login HTTP calls
// rather than adding to their timeout budget. Uses a distinct consumer
// group in NODE_ENV=test (modules/notifications/consumer.ts) so this never
// contends with a live `npm run dev` server's own consumer on the same
// Redpanda instance.
void connectProducer();
startNotificationsConsumer();

// Publishes whatever's currently sitting unpublished in the Outbox, then
// gives the async pipeline (Redpanda round-trip + consumer processing)
// real time to actually deliver and create the resulting Notification row
// — this is genuinely asynchronous now (ADR-0027), unlike before this
// refactor, so a test can no longer assert on `prisma.notification` the
// instant its triggering HTTP call returns.
async function publishOutboxAndWaitFor<T>(
  find: () => Promise<T | null>,
  timeoutMs = 10_000,
): Promise<T> {
  await runOutboxPublisherOnce();
  const start = Date.now();
  for (;;) {
    const result = await find();
    if (result) return result;
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for the outbox -> Kafka -> consumer pipeline to produce a result');
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const runId = Date.now();
let counter = 0;
const testEmails: string[] = [];
const createdAuctionIds: string[] = [];

function uniqueEmail(label: string): string {
  counter += 1;
  const email = `test-notifications-${runId}-${counter}-${label}@example.com`;
  testEmails.push(email);
  return email;
}

async function registerAndLogin(label = 'user') {
  const email = uniqueEmail(label);
  const password = 'correct-horse-battery';
  await request(app).post('/api/v1/auth/register').send({ email, password, name: 'Notifications Test' });
  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
  return { accessToken: loginRes.body.accessToken as string, userId: loginRes.body.user.id as string };
}

async function createActiveAuction(sellerToken: string, reservePriceCents?: number) {
  const createRes = await request(app)
    .post('/api/v1/auctions')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({
      title: 'Notifications Test Lot',
      description: 'desc',
      category: 'OTHER',
      condition: 'GOOD',
      startingPriceCents: 1000,
      ...(reservePriceCents !== undefined ? { reservePriceCents } : {}),
    });
  const auctionId = createRes.body.auction.id as string;
  createdAuctionIds.push(auctionId);

  await request(app)
    .post(`/api/v1/auctions/${auctionId}/publish`)
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ endTime: new Date(Date.now() + 3_600_000).toISOString() });
  await request(app).post(`/api/v1/auctions/${auctionId}/start`).set('Authorization', `Bearer ${sellerToken}`);

  return auctionId;
}

function placeBid(auctionId: string, token: string, amountCents: number) {
  return request(app)
    .post(`/api/v1/auctions/${auctionId}/bids`)
    .set('Authorization', `Bearer ${token}`)
    .send({ amountCents, idempotencyKey: `${auctionId}-${amountCents}-${Math.random()}` });
}

async function forceExpireAndClose(auctionId: string) {
  await prisma.auction.update({ where: { id: auctionId }, data: { endTime: new Date(Date.now() - 1_000) } });
  await runClosingWorkerOnce();
}

async function waitForOrderStatus(orderId: string, status: string, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    if (order.status === status) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for order ${orderId} to reach ${status} (was ${order.status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

afterAll(async () => {
  await stopNotificationsConsumer();
  await disconnectProducer();
  await prisma.notification.deleteMany({ where: { auctionId: { in: createdAuctionIds } } });
  await prisma.payment.deleteMany({ where: { order: { auctionId: { in: createdAuctionIds } } } });
  await prisma.order.deleteMany({ where: { auctionId: { in: createdAuctionIds } } });
  await prisma.bid.deleteMany({ where: { auctionId: { in: createdAuctionIds } } });
  await prisma.auction.deleteMany({ where: { id: { in: createdAuctionIds } } });
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  await prisma.$disconnect();
});

describe('notifications', () => {
  it('notifies the previous highest bidder when outbid, but not on a self-replay or self-outbid', async () => {
    const seller = await registerAndLogin('seller');
    const bidderA = await registerAndLogin('bidderA');
    const bidderB = await registerAndLogin('bidderB');
    const auctionId = await createActiveAuction(seller.accessToken);

    const first = await placeBid(auctionId, bidderA.accessToken, 1500);
    expect(first.status).toBe(201);
    // Second bid from bidderA again: should NOT notify bidderA about
    // outbidding themselves.
    const second = await placeBid(auctionId, bidderA.accessToken, 2000);
    expect(second.status).toBe(201);
    const third = await placeBid(auctionId, bidderB.accessToken, 2500);
    expect(third.status).toBe(201);

    const notification = await publishOutboxAndWaitFor(() =>
      prisma.notification.findFirst({ where: { auctionId, type: 'OUTBID' } }),
    );
    expect(notification.userId).toBe(bidderA.userId);
    expect((notification.data as Record<string, number>).newAmountCents).toBe(2500);

    // Only one OUTBID notification total — bidderA's own second bid
    // (outbidding themselves) never produced one.
    const allOutbid = await prisma.notification.findMany({ where: { auctionId, type: 'OUTBID' } });
    expect(allOutbid).toHaveLength(1);
  });

  it('notifies buyer (AUCTION_WON) and seller (AUCTION_SOLD) when an auction sells', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const auctionId = await createActiveAuction(seller.accessToken);

    const bidRes = await placeBid(auctionId, buyer.accessToken, 3000);
    expect(bidRes.status).toBe(201);

    await forceExpireAndClose(auctionId);

    const order = await prisma.order.findUniqueOrThrow({ where: { auctionId } });

    const wonNotif = await publishOutboxAndWaitFor(() =>
      prisma.notification.findFirst({ where: { auctionId, type: 'AUCTION_WON' } }),
    );
    expect(wonNotif.userId).toBe(buyer.userId);
    expect(wonNotif.orderId).toBe(order.id);

    // Both notifications come from the SAME outbox event (ADR-0027), created
    // sequentially by the consumer — a short poll (rather than an
    // immediate read) avoids relying on exactly how close together those
    // two inserts land.
    const soldNotif = await publishOutboxAndWaitFor(
      () => prisma.notification.findFirst({ where: { auctionId, type: 'AUCTION_SOLD' } }),
      2_000,
    );
    expect(soldNotif.userId).toBe(seller.userId);
  });

  it('notifies the seller when an auction ends without meeting its reserve', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const auctionId = await createActiveAuction(seller.accessToken, 5000);

    const bidRes = await placeBid(auctionId, buyer.accessToken, 2000);
    expect(bidRes.status).toBe(201);

    await forceExpireAndClose(auctionId);

    const notification = await publishOutboxAndWaitFor(() =>
      prisma.notification.findFirst({ where: { auctionId, type: 'AUCTION_RESERVE_NOT_MET' } }),
    );
    expect(notification.userId).toBe(seller.userId);

    // No winner, so no won/sold notifications either.
    const wonOrSold = await prisma.notification.findMany({
      where: { auctionId, type: { in: ['AUCTION_WON', 'AUCTION_SOLD'] } },
    });
    expect(wonOrSold).toHaveLength(0);
  });

  it('notifies the seller (PAYMENT_RECEIVED) once the buyer pays', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const auctionId = await createActiveAuction(seller.accessToken);
    const bidRes = await placeBid(auctionId, buyer.accessToken, 4000);
    expect(bidRes.status).toBe(201);
    await forceExpireAndClose(auctionId);
    const order = await prisma.order.findUniqueOrThrow({ where: { auctionId } });

    await request(app)
      .post(`/api/v1/orders/${order.id}/pay`)
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ idempotencyKey: 'notif-payment-test' });

    await waitForOrderStatus(order.id, 'PAID');

    const notification = await publishOutboxAndWaitFor(() =>
      prisma.notification.findFirst({ where: { orderId: order.id, type: 'PAYMENT_RECEIVED' } }),
    );
    expect(notification.userId).toBe(seller.userId);
    expect((notification.data as Record<string, number>).amountCents).toBe(4000);
  });

  describe('REST API', () => {
    it('lists a user\'s own notifications with an unread count, newest first', async () => {
      const seller = await registerAndLogin('seller');
      const buyer = await registerAndLogin('buyer');
      const auctionId = await createActiveAuction(seller.accessToken);
      await placeBid(auctionId, buyer.accessToken, 1200);
      await placeBid(auctionId, buyer.accessToken, 1500); // buyer outbidding themselves — no notification
      const bidder2 = await registerAndLogin('bidder2');
      await placeBid(auctionId, bidder2.accessToken, 1800); // outbids buyer for real

      await publishOutboxAndWaitFor(() => prisma.notification.findFirst({ where: { userId: buyer.userId, auctionId } }));

      const res = await request(app).get('/api/v1/notifications').set('Authorization', `Bearer ${buyer.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.notifications).toHaveLength(1);
      expect(res.body.notifications[0].type).toBe('OUTBID');
      expect(res.body.unreadCount).toBe(1);
    });

    it('marks a single notification read, and rejects marking someone else\'s', async () => {
      const seller = await registerAndLogin('seller');
      const buyer = await registerAndLogin('buyer');
      const bidder2 = await registerAndLogin('bidder2');
      const auctionId = await createActiveAuction(seller.accessToken);
      await placeBid(auctionId, buyer.accessToken, 1200);
      await placeBid(auctionId, bidder2.accessToken, 1800);

      const notification = await publishOutboxAndWaitFor(() =>
        prisma.notification.findFirst({ where: { userId: buyer.userId, auctionId, type: 'OUTBID' } }),
      );

      const strangerAttempt = await request(app)
        .post(`/api/v1/notifications/${notification.id}/read`)
        .set('Authorization', `Bearer ${bidder2.accessToken}`);
      expect(strangerAttempt.status).toBe(404);

      const ownAttempt = await request(app)
        .post(`/api/v1/notifications/${notification.id}/read`)
        .set('Authorization', `Bearer ${buyer.accessToken}`);
      expect(ownAttempt.status).toBe(200);
      expect(ownAttempt.body.notification.readAt).not.toBeNull();
    });

    it('marks all of a user\'s notifications read in one call', async () => {
      const seller = await registerAndLogin('seller');
      const buyer = await registerAndLogin('buyer');
      const bidder2 = await registerAndLogin('bidder2');
      const bidder3 = await registerAndLogin('bidder3');
      const auctionId = await createActiveAuction(seller.accessToken);
      await placeBid(auctionId, buyer.accessToken, 1200);
      await placeBid(auctionId, bidder2.accessToken, 1500); // outbids buyer
      await placeBid(auctionId, bidder3.accessToken, 1800); // outbids bidder2

      await publishOutboxAndWaitFor(() =>
        prisma.notification.findFirst({ where: { userId: bidder2.userId, auctionId, type: 'OUTBID' } }),
      );

      const before = await request(app)
        .get('/api/v1/notifications')
        .set('Authorization', `Bearer ${bidder2.accessToken}`);
      expect(before.body.unreadCount).toBeGreaterThanOrEqual(1);

      const readAll = await request(app)
        .post('/api/v1/notifications/read-all')
        .set('Authorization', `Bearer ${bidder2.accessToken}`);
      expect(readAll.status).toBe(204);

      const after = await request(app)
        .get('/api/v1/notifications')
        .set('Authorization', `Bearer ${bidder2.accessToken}`);
      expect(after.body.unreadCount).toBe(0);
    });
  });
});
