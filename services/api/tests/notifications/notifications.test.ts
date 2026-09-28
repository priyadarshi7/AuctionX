import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { runOnce } from '../../src/infrastructure/jobs/auctionClosingWorker';

const app = createApp();

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
  await runOnce();
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

    const notifications = await prisma.notification.findMany({ where: { auctionId, type: 'OUTBID' } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.userId).toBe(bidderA.userId);
    expect((notifications[0]!.data as Record<string, number>).newAmountCents).toBe(2500);
  });

  it('notifies buyer (AUCTION_WON) and seller (AUCTION_SOLD) when an auction sells', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const auctionId = await createActiveAuction(seller.accessToken);

    const bidRes = await placeBid(auctionId, buyer.accessToken, 3000);
    expect(bidRes.status).toBe(201);

    await forceExpireAndClose(auctionId);

    const order = await prisma.order.findUniqueOrThrow({ where: { auctionId } });

    const wonNotifs = await prisma.notification.findMany({ where: { auctionId, type: 'AUCTION_WON' } });
    expect(wonNotifs).toHaveLength(1);
    expect(wonNotifs[0]!.userId).toBe(buyer.userId);
    expect(wonNotifs[0]!.orderId).toBe(order.id);

    const soldNotifs = await prisma.notification.findMany({ where: { auctionId, type: 'AUCTION_SOLD' } });
    expect(soldNotifs).toHaveLength(1);
    expect(soldNotifs[0]!.userId).toBe(seller.userId);
  });

  it('notifies the seller when an auction ends without meeting its reserve', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const auctionId = await createActiveAuction(seller.accessToken, 5000);

    const bidRes = await placeBid(auctionId, buyer.accessToken, 2000);
    expect(bidRes.status).toBe(201);

    await forceExpireAndClose(auctionId);

    const notifs = await prisma.notification.findMany({ where: { auctionId, type: 'AUCTION_RESERVE_NOT_MET' } });
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.userId).toBe(seller.userId);

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

    const notifs = await prisma.notification.findMany({ where: { orderId: order.id, type: 'PAYMENT_RECEIVED' } });
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.userId).toBe(seller.userId);
    expect((notifs[0]!.data as Record<string, number>).amountCents).toBe(4000);
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

      const notification = await prisma.notification.findFirstOrThrow({
        where: { userId: buyer.userId, auctionId, type: 'OUTBID' },
      });

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
