import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { ANTI_SNIPING_WINDOW_MS } from '../../src/modules/bids/antiSniping';

const app = createApp();

const runId = Date.now();
let counter = 0;
const testEmails: string[] = [];
const createdAuctionIds: string[] = [];

function uniqueEmail(label: string): string {
  counter += 1;
  const email = `test-anti-sniping-${runId}-${counter}-${label}@example.com`.toLowerCase();
  testEmails.push(email);
  return email;
}

async function registerAndLogin(label = 'user') {
  const email = uniqueEmail(label);
  const password = 'correct-horse-battery';
  await request(app).post('/api/v1/auth/register').send({ email, password, name: 'Anti Sniping Test' });
  await prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
  return { accessToken: loginRes.body.accessToken as string };
}

async function createActiveAuction(sellerToken: string, endTime: Date, startingPriceCents = 1000) {
  const createRes = await request(app)
    .post('/api/v1/auctions')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({
      title: 'Anti-Sniping Test Lot',
      description: 'desc',
      category: 'OTHER',
      condition: 'GOOD',
      startingPriceCents,
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

function placeBid(auctionId: string, token: string, amountCents: number, idempotencyKey?: string) {
  return request(app)
    .post(`/api/v1/auctions/${auctionId}/bids`)
    .set('Authorization', `Bearer ${token}`)
    .send({ amountCents, idempotencyKey: idempotencyKey ?? randomUUID() });
}

afterAll(async () => {
  await prisma.bid.deleteMany({ where: { auctionId: { in: createdAuctionIds } } });
  await prisma.auction.deleteMany({ where: { id: { in: createdAuctionIds } } });
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  await prisma.$disconnect();
});

describe('anti-sniping extension on bid placement', () => {
  it('does not extend an auction with plenty of time left', async () => {
    const seller = await registerAndLogin('seller');
    const bidder = await registerAndLogin('bidder');
    const originalEndTime = new Date(Date.now() + 3_600_000);
    const auctionId = await createActiveAuction(seller.accessToken, originalEndTime);

    const res = await placeBid(auctionId, bidder.accessToken, 1500);
    expect(res.status).toBe(201);
    expect(res.body.auctionExtended).toBe(false);

    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: auctionId } });
    expect(auction.endTime!.getTime()).toBe(originalEndTime.getTime());
  });

  it('extends an auction whose end is within the anti-sniping window', async () => {
    const seller = await registerAndLogin('seller');
    const bidder = await registerAndLogin('bidder');
    const originalEndTime = new Date(Date.now() + 5_000); // well inside the 30s window
    const auctionId = await createActiveAuction(seller.accessToken, originalEndTime);

    const before = Date.now();
    const res = await placeBid(auctionId, bidder.accessToken, 1500);
    const after = Date.now();

    expect(res.status).toBe(201);
    expect(res.body.auctionExtended).toBe(true);

    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: auctionId } });
    const newEndTimeMs = auction.endTime!.getTime();
    expect(newEndTimeMs).toBeGreaterThan(originalEndTime.getTime());
    // New end should be ~WINDOW_MS from whenever the bid was actually
    // processed (before/after bracket the request's real execution time).
    expect(newEndTimeMs).toBeGreaterThanOrEqual(before + ANTI_SNIPING_WINDOW_MS - 500);
    expect(newEndTimeMs).toBeLessThanOrEqual(after + ANTI_SNIPING_WINDOW_MS + 500);
  });

  it('chains: a second late bid extends again from its own arrival time', async () => {
    const seller = await registerAndLogin('seller');
    const bidderA = await registerAndLogin('bidderA');
    const bidderB = await registerAndLogin('bidderB');
    const auctionId = await createActiveAuction(seller.accessToken, new Date(Date.now() + 5_000));

    const first = await placeBid(auctionId, bidderA.accessToken, 1500);
    expect(first.body.auctionExtended).toBe(true);
    const afterFirst = await prisma.auction.findUniqueOrThrow({ where: { id: auctionId } });

    // The auction is now ~30s out again, still inside the window, so a
    // second valid bid should extend it again from ITS OWN arrival time.
    const beforeSecond = Date.now();
    const second = await placeBid(auctionId, bidderB.accessToken, 2000);
    expect(second.body.auctionExtended).toBe(true);

    const afterSecond = await prisma.auction.findUniqueOrThrow({ where: { id: auctionId } });
    expect(afterSecond.endTime!.getTime()).toBeGreaterThan(afterFirst.endTime!.getTime());
    expect(afterSecond.endTime!.getTime()).toBeGreaterThanOrEqual(
      beforeSecond + ANTI_SNIPING_WINDOW_MS - 500,
    );
  });

  it('does not extend when the bid is rejected (too low)', async () => {
    const seller = await registerAndLogin('seller');
    const bidder = await registerAndLogin('bidder');
    const originalEndTime = new Date(Date.now() + 5_000);
    const auctionId = await createActiveAuction(seller.accessToken, originalEndTime);

    const res = await placeBid(auctionId, bidder.accessToken, 1000); // not above starting price
    expect(res.status).toBe(400);

    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: auctionId } });
    expect(auction.endTime!.getTime()).toBe(originalEndTime.getTime());
  });

  it('an idempotent replay does not re-extend or report a fresh extension', async () => {
    const seller = await registerAndLogin('seller');
    const bidder = await registerAndLogin('bidder');
    const auctionId = await createActiveAuction(seller.accessToken, new Date(Date.now() + 5_000));
    const key = randomUUID();

    const first = await placeBid(auctionId, bidder.accessToken, 1500, key);
    expect(first.body.auctionExtended).toBe(true);
    const afterFirst = await prisma.auction.findUniqueOrThrow({ where: { id: auctionId } });

    const replay = await placeBid(auctionId, bidder.accessToken, 1500, key);
    expect(replay.status).toBe(201);
    expect(replay.body.auctionExtended).toBe(false);
    expect(replay.body.bid.id).toBe(first.body.bid.id);

    const afterReplay = await prisma.auction.findUniqueOrThrow({ where: { id: auctionId } });
    expect(afterReplay.endTime!.getTime()).toBe(afterFirst.endTime!.getTime());
  });
});
