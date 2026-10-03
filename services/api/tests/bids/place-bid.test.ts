import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';

const app = createApp();

const runId = Date.now();
let counter = 0;
const testEmails: string[] = [];
const createdAuctionIds: string[] = [];

function uniqueEmail(label: string): string {
  counter += 1;
  const email = `test-bid-${runId}-${counter}-${label}@example.com`.toLowerCase();
  testEmails.push(email);
  return email;
}

async function registerAndLogin(label = 'user') {
  const email = uniqueEmail(label);
  const password = 'correct-horse-battery';
  await request(app).post('/api/v1/auth/register').send({ email, password, name: 'Bid Test' });
  await prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
  return { accessToken: loginRes.body.accessToken as string, userId: loginRes.body.user.id as string };
}

async function createActiveAuction(sellerToken: string, startingPriceCents = 1000, endTime?: Date) {
  const createRes = await request(app)
    .post('/api/v1/auctions')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({
      title: 'Bid Test Lot',
      description: 'A lot for bid testing.',
      category: 'OTHER',
      condition: 'GOOD',
      startingPriceCents,
    });
  const auctionId = createRes.body.auction.id as string;
  createdAuctionIds.push(auctionId);

  await request(app)
    .post(`/api/v1/auctions/${auctionId}/publish`)
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ endTime: (endTime ?? new Date(Date.now() + 3_600_000)).toISOString() });

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

describe('POST /api/v1/auctions/:auctionId/bids', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(app)
      .post('/api/v1/auctions/whatever/bids')
      .send({ amountCents: 1000, idempotencyKey: randomUUID() });
    expect(res.status).toBe(401);
  });

  it('returns 404 for a nonexistent auction', async () => {
    const { accessToken } = await registerAndLogin('bidder');
    const res = await placeBid('00000000-0000-0000-0000-000000000000', accessToken, 1000);
    expect(res.status).toBe(404);
  });

  it('rejects a seller bidding on their own auction', async () => {
    const seller = await registerAndLogin('seller');
    const auctionId = await createActiveAuction(seller.accessToken);

    const res = await placeBid(auctionId, seller.accessToken, 2000);
    expect(res.status).toBe(403);
  });

  it('rejects a bid on an auction that is not ACTIVE', async () => {
    const seller = await registerAndLogin('seller');
    const bidder = await registerAndLogin('bidder');
    const createRes = await request(app)
      .post('/api/v1/auctions')
      .set('Authorization', `Bearer ${seller.accessToken}`)
      .send({
        title: 'Draft Lot',
        description: 'desc',
        category: 'OTHER',
        condition: 'GOOD',
        startingPriceCents: 1000,
      });
    const auctionId = createRes.body.auction.id as string;
    createdAuctionIds.push(auctionId);

    const res = await placeBid(auctionId, bidder.accessToken, 2000);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AUCTION_NOT_ACTIVE');
  });

  it('rejects a bid on an ACTIVE auction whose scheduled end has passed', async () => {
    const seller = await registerAndLogin('seller');
    const bidder = await registerAndLogin('bidder');
    const auctionId = await createActiveAuction(seller.accessToken, 1000, new Date(Date.now() + 500));
    await new Promise((resolve) => setTimeout(resolve, 700));

    const res = await placeBid(auctionId, bidder.accessToken, 2000);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AUCTION_SCHEDULE_EXPIRED');
  });

  it('rejects a bid that does not exceed the current price', async () => {
    const seller = await registerAndLogin('seller');
    const bidder = await registerAndLogin('bidder');
    const auctionId = await createActiveAuction(seller.accessToken, 1000);

    const res = await placeBid(auctionId, bidder.accessToken, 1000);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an invalid payload', async () => {
    const seller = await registerAndLogin('seller');
    const bidder = await registerAndLogin('bidder');
    const auctionId = await createActiveAuction(seller.accessToken);

    const res = await request(app)
      .post(`/api/v1/auctions/${auctionId}/bids`)
      .set('Authorization', `Bearer ${bidder.accessToken}`)
      .send({ amountCents: -5 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('accepts a valid bid and updates the auction current price', async () => {
    const seller = await registerAndLogin('seller');
    const bidder = await registerAndLogin('bidder');
    const auctionId = await createActiveAuction(seller.accessToken, 1000);

    const res = await placeBid(auctionId, bidder.accessToken, 1500);
    expect(res.status).toBe(201);
    expect(res.body.bid.amountCents).toBe(1500);
    expect(res.body.bid.auctionId).toBe(auctionId);

    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: auctionId } });
    expect(auction.currentPriceCents).toBe(1500);
  });

  it('replays the same result for a repeated idempotency key (sequential retry)', async () => {
    const seller = await registerAndLogin('seller');
    const bidder = await registerAndLogin('bidder');
    const auctionId = await createActiveAuction(seller.accessToken, 1000);
    const key = randomUUID();

    const first = await placeBid(auctionId, bidder.accessToken, 1500, key);
    expect(first.status).toBe(201);

    const second = await placeBid(auctionId, bidder.accessToken, 1500, key);
    expect(second.status).toBe(201);
    expect(second.body.bid.id).toBe(first.body.bid.id);

    const rows = await prisma.bid.findMany({ where: { auctionId } });
    expect(rows).toHaveLength(1);
  });

  it('replays the same result for a repeated idempotency key under a genuine race', async () => {
    const seller = await registerAndLogin('seller');
    const bidder = await registerAndLogin('bidder');
    const auctionId = await createActiveAuction(seller.accessToken, 1000);
    const key = randomUUID();

    const [a, b] = await Promise.all([
      placeBid(auctionId, bidder.accessToken, 1500, key),
      placeBid(auctionId, bidder.accessToken, 1500, key),
    ]);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.bid.id).toBe(b.body.bid.id);

    const rows = await prisma.bid.findMany({ where: { auctionId } });
    expect(rows).toHaveLength(1);
  });

  // Same idempotency key, but reused across TWO DIFFERENT auctions,
  // concurrently — the case ADR-0011 flags as an accepted tradeoff (the key
  // is scoped to the bidder only, not also the auction) and the one case
  // that genuinely still exercises service.ts's P2002 catch, since the two
  // requests lock different auction rows and so can't see each other via
  // repository.ts's in-transaction re-check the way two same-auction
  // requests would.
  // The bid's outbox writes happen in the same raw-SQL statement as the bid
  // insert (repository.ts) — nothing else in this file looks at
  // outbox_events, so a broken CTE there would otherwise pass every test
  // here while silently breaking search reindexing and outbid notifications.
  it('writes one reindex event per accepted bid, and an outbid event only when someone else is outbid', async () => {
    const seller = await registerAndLogin('seller');
    const bidderA = await registerAndLogin('bidderA');
    const bidderB = await registerAndLogin('bidderB');
    const auctionId = await createActiveAuction(seller.accessToken, 1000);
    // create/publish/start write their own reindex events — only count the bids'.
    await prisma.outboxEvent.deleteMany({ where: { key: auctionId } });

    expect((await placeBid(auctionId, bidderA.accessToken, 1500)).status).toBe(201); // first bid: no one outbid
    expect((await placeBid(auctionId, bidderA.accessToken, 1600)).status).toBe(201); // self-outbid: no event
    expect((await placeBid(auctionId, bidderB.accessToken, 2000)).status).toBe(201); // outbids A

    const events = await prisma.outboxEvent.findMany({ where: { key: auctionId } });
    await prisma.outboxEvent.deleteMany({ where: { key: auctionId } });

    const reindex = events.filter((e) => (e.payload as { type: string }).type === 'auction.reindex');
    const outbid = events.filter((e) => (e.payload as { type: string }).type === 'bid.outbid');
    expect(reindex).toHaveLength(3);
    expect(outbid).toHaveLength(1);
    expect(outbid[0]!.topic).toBe('bid-events');
    expect(outbid[0]!.payload).toEqual({
      type: 'bid.outbid',
      auctionId,
      outbidUserId: bidderA.userId,
      previousAmountCents: 1600,
      newAmountCents: 2000,
    });

    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: auctionId } });
    expect(auction.currentPriceCents).toBe(2000);
  });

  it('replays the same result when one idempotency key is reused across two different auctions at once', async () => {
    const seller = await registerAndLogin('seller');
    const bidder = await registerAndLogin('bidder');
    const auctionA = await createActiveAuction(seller.accessToken, 1000);
    const auctionB = await createActiveAuction(seller.accessToken, 1000);
    const key = randomUUID();

    const [a, b] = await Promise.all([
      placeBid(auctionA, bidder.accessToken, 1500, key),
      placeBid(auctionB, bidder.accessToken, 1500, key),
    ]);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    // Both responses describe the SAME persisted bid — whichever auction's
    // transaction actually won the insert — not two independent bids.
    expect(a.body.bid.id).toBe(b.body.bid.id);

    const rows = await prisma.bid.findMany({
      where: { auctionId: { in: [auctionA, auctionB] } },
    });
    expect(rows).toHaveLength(1);
  });

  // Section 36's explicit concurrency requirement: many simultaneous bids on
  // ONE auction must never lose an accepted bid, never accept a bid out of
  // price order, and leave the auction's price matching exactly the highest
  // bid that was actually persisted. This is the test that would catch a
  // missing/broken row lock — without it, two concurrent transactions could
  // both read the same stale currentPriceCents and both think their bid is
  // valid, producing a non-monotonic sequence or a "lost update" where the
  // final price doesn't match the true max.
  it('handles many concurrent bidders on one auction with no lost or out-of-order bids', async () => {
    const seller = await registerAndLogin('seller');
    const auctionId = await createActiveAuction(seller.accessToken, 1000);

    const bidderCount = 15;
    const bidders = await Promise.all(
      Array.from({ length: bidderCount }, () => registerAndLogin('concurrent')),
    );

    const responses = await Promise.all(
      bidders.map((bidder, i) => placeBid(auctionId, bidder.accessToken, 1000 + (i + 1) * 100)),
    );

    const successCount = responses.filter((r) => r.status === 201).length;
    const rejectedCount = responses.filter((r) => r.status === 400).length;
    expect(successCount + rejectedCount).toBe(bidderCount);
    expect(successCount).toBeGreaterThan(0);

    const bidRows = await prisma.bid.findMany({
      where: { auctionId },
      orderBy: { createdAt: 'asc' },
    });

    // Every successful response has exactly one corresponding row, and vice
    // versa — no lost accepted bid, no phantom row.
    expect(bidRows).toHaveLength(successCount);

    // No bid was accepted out of price order — proves the lock actually
    // serialized these transactions instead of letting two of them decide
    // against the same stale price concurrently.
    for (let i = 1; i < bidRows.length; i += 1) {
      expect(bidRows[i]!.amountCents).toBeGreaterThan(bidRows[i - 1]!.amountCents);
    }

    // The auction's final price matches the highest bid actually
    // persisted — no lost update from two concurrent auction-row writes.
    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: auctionId } });
    const highestBid = bidRows.at(-1);
    expect(highestBid).toBeDefined();
    expect(auction.currentPriceCents).toBe(highestBid!.amountCents);
  });
});
