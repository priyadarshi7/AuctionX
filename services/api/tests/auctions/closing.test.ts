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
  const email = `test-closing-${runId}-${counter}-${label}@example.com`.toLowerCase();
  testEmails.push(email);
  return email;
}

async function registerAndLogin(label = 'user') {
  const email = uniqueEmail(label);
  const password = 'correct-horse-battery';
  await request(app).post('/api/v1/auth/register').send({ email, password, name: 'Closing Test' });
  await prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
  return { accessToken: loginRes.body.accessToken as string };
}

async function createActiveAuction(
  sellerToken: string,
  endTime: Date,
  startingPriceCents = 1000,
  reservePriceCents?: number,
) {
  const createRes = await request(app)
    .post('/api/v1/auctions')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({
      title: 'Closing Test Lot',
      description: 'desc',
      category: 'OTHER',
      condition: 'GOOD',
      startingPriceCents,
      ...(reservePriceCents !== undefined ? { reservePriceCents } : {}),
    });
  const auctionId = createRes.body.auction.id as string;
  createdAuctionIds.push(auctionId);

  await request(app)
    .post(`/api/v1/auctions/${auctionId}/publish`)
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ endTime: endTime.toISOString() });
  await request(app)
    .post(`/api/v1/auctions/${auctionId}/start`)
    .set('Authorization', `Bearer ${sellerToken}`);

  return auctionId;
}

function placeBid(auctionId: string, token: string, amountCents: number) {
  return request(app)
    .post(`/api/v1/auctions/${auctionId}/bids`)
    .set('Authorization', `Bearer ${token}`)
    .send({ amountCents, idempotencyKey: `${auctionId}-${amountCents}-${Math.random()}` });
}

async function forceExpire(auctionId: string) {
  await prisma.auction.update({
    where: { id: auctionId },
    data: { endTime: new Date(Date.now() - 1_000) },
  });
}

afterAll(async () => {
  // Order.auctionId/winningBidId both use onDelete: Restrict (an order is a
  // business record, not disposable), so it must be deleted before its
  // parent bid/auction rows or this cleanup itself would fail.
  await prisma.order.deleteMany({ where: { auctionId: { in: createdAuctionIds } } });
  await prisma.bid.deleteMany({ where: { auctionId: { in: createdAuctionIds } } });
  await prisma.auction.deleteMany({ where: { id: { in: createdAuctionIds } } });
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  await prisma.$disconnect();
});

describe('auction closing worker', () => {
  it('closes an ACTIVE auction past its endTime and records the winning bid', async () => {
    const seller = await registerAndLogin('seller');
    const bidderLow = await registerAndLogin('bidderLow');
    const bidderHigh = await registerAndLogin('bidderHigh');
    const auctionId = await createActiveAuction(seller.accessToken, new Date(Date.now() + 3_600_000));

    await placeBid(auctionId, bidderLow.accessToken, 1500);
    const highBid = await placeBid(auctionId, bidderHigh.accessToken, 2000);
    expect(highBid.status).toBe(201);

    await forceExpire(auctionId);
    await runOnce();

    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: auctionId } });
    expect(auction.status).toBe('ENDED');
    expect(auction.endedAt).not.toBeNull();

    const bids = await prisma.bid.findMany({ where: { auctionId }, orderBy: { createdAt: 'desc' } });
    expect(bids[0]!.id).toBe(highBid.body.bid.id);
    expect(bids[0]!.amountCents).toBe(2000);

    const order = await prisma.order.findUnique({ where: { auctionId } });
    expect(order).not.toBeNull();
    expect(order!.winningBidId).toBe(highBid.body.bid.id);
    expect(order!.amountCents).toBe(2000);
    expect(order!.status).toBe('PENDING_PAYMENT');
  });

  it('creates no Order when reservePriceCents is never met, even though bids exist', async () => {
    const seller = await registerAndLogin('seller');
    const bidder = await registerAndLogin('bidder');
    const auctionId = await createActiveAuction(seller.accessToken, new Date(Date.now() + 3_600_000), 1000, 5000);

    const bidRes = await placeBid(auctionId, bidder.accessToken, 2000);
    expect(bidRes.status).toBe(201);

    await forceExpire(auctionId);
    await runOnce();

    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: auctionId } });
    expect(auction.status).toBe('ENDED');

    const order = await prisma.order.findUnique({ where: { auctionId } });
    expect(order).toBeNull();
  });

  it('creates an Order when the highest bid meets reservePriceCents exactly', async () => {
    const seller = await registerAndLogin('seller');
    const bidder = await registerAndLogin('bidder');
    const auctionId = await createActiveAuction(seller.accessToken, new Date(Date.now() + 3_600_000), 1000, 5000);

    const bidRes = await placeBid(auctionId, bidder.accessToken, 5000);
    expect(bidRes.status).toBe(201);

    await forceExpire(auctionId);
    await runOnce();

    const order = await prisma.order.findUnique({ where: { auctionId } });
    expect(order).not.toBeNull();
    expect(order!.amountCents).toBe(5000);
  });

  it('closes an auction with zero bids (no winner)', async () => {
    const seller = await registerAndLogin('seller');
    const auctionId = await createActiveAuction(seller.accessToken, new Date(Date.now() + 3_600_000));

    await forceExpire(auctionId);
    await runOnce();

    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: auctionId } });
    expect(auction.status).toBe('ENDED');

    const bids = await prisma.bid.findMany({ where: { auctionId } });
    expect(bids).toHaveLength(0);
  });

  it('closes a PAUSED auction past its endTime too', async () => {
    const seller = await registerAndLogin('seller');
    const auctionId = await createActiveAuction(seller.accessToken, new Date(Date.now() + 3_600_000));
    await request(app)
      .post(`/api/v1/auctions/${auctionId}/pause`)
      .set('Authorization', `Bearer ${seller.accessToken}`);

    await forceExpire(auctionId);
    await runOnce();

    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: auctionId } });
    expect(auction.status).toBe('ENDED');
  });

  it('does not touch an ACTIVE auction whose endTime has not passed', async () => {
    const seller = await registerAndLogin('seller');
    const auctionId = await createActiveAuction(seller.accessToken, new Date(Date.now() + 3_600_000));

    await runOnce();

    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: auctionId } });
    expect(auction.status).toBe('ACTIVE');
    expect(auction.endedAt).toBeNull();
  });

  it('is idempotent: running twice on an already-closed auction changes nothing further', async () => {
    const seller = await registerAndLogin('seller');
    const auctionId = await createActiveAuction(seller.accessToken, new Date(Date.now() + 3_600_000));
    await forceExpire(auctionId);
    await runOnce();

    const afterFirst = await prisma.auction.findUniqueOrThrow({ where: { id: auctionId } });
    await runOnce();
    const afterSecond = await prisma.auction.findUniqueOrThrow({ where: { id: auctionId } });

    expect(afterSecond.status).toBe('ENDED');
    expect(afterSecond.endedAt!.getTime()).toBe(afterFirst.endedAt!.getTime());
  });

  it('does not close an auction that anti-sniping pushed back out since the candidate scan', async () => {
    // Simulates the race: the unlocked scan finds a candidate, but by the
    // time the per-auction lock is acquired, the schedule has moved (here,
    // simulated directly rather than via a real concurrent bid — the
    // concurrency mechanics themselves are already proven in ADR-0012's
    // tests; this test is specifically about closeAuctionIfExpired's own
    // re-check of the LOCKED, current endTime).
    const seller = await registerAndLogin('seller');
    const auctionId = await createActiveAuction(seller.accessToken, new Date(Date.now() + 3_600_000));
    await forceExpire(auctionId);
    // "Un-expire" it again right before the worker would otherwise close it.
    await prisma.auction.update({
      where: { id: auctionId },
      data: { endTime: new Date(Date.now() + 3_600_000) },
    });

    await runOnce();

    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: auctionId } });
    expect(auction.status).toBe('ACTIVE');
  });

  it('rejects a bid on an auction the worker has already ended', async () => {
    const seller = await registerAndLogin('seller');
    const bidder = await registerAndLogin('bidder');
    const auctionId = await createActiveAuction(seller.accessToken, new Date(Date.now() + 3_600_000));
    await forceExpire(auctionId);
    await runOnce();

    const res = await placeBid(auctionId, bidder.accessToken, 5000);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AUCTION_NOT_ACTIVE');
  });

  it('closes an auction for real after a short real-time wait, end to end via the API', async () => {
    // No bid placed here deliberately: any bid this close to a 1s-duration
    // auction would land inside the 30s anti-sniping window and push
    // endTime forward (ADR-0013), which would defeat the point of this
    // specific test — proving the worker closes something because real
    // time actually elapsed, not via forceExpire's direct DB write.
    const seller = await registerAndLogin('seller');
    const auctionId = await createActiveAuction(seller.accessToken, new Date(Date.now() + 1_000));

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await runOnce();

    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: auctionId } });
    expect(auction.status).toBe('ENDED');
  });
});
