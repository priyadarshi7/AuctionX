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
  const email = `test-list-bids-${runId}-${counter}-${label}@example.com`;
  testEmails.push(email);
  return email;
}

async function registerAndLogin(label = 'user') {
  const email = uniqueEmail(label);
  const password = 'correct-horse-battery';
  await request(app).post('/api/v1/auth/register').send({ email, password, name: 'List Bids Test' });
  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
  return { accessToken: loginRes.body.accessToken as string };
}

async function createActiveAuction(sellerToken: string) {
  const createRes = await request(app)
    .post('/api/v1/auctions')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({
      title: 'List Bids Test Lot',
      description: 'desc',
      category: 'OTHER',
      condition: 'GOOD',
      startingPriceCents: 1000,
    });
  const auctionId = createRes.body.auction.id as string;
  createdAuctionIds.push(auctionId);

  await request(app)
    .post(`/api/v1/auctions/${auctionId}/publish`)
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ endTime: new Date(Date.now() + 3_600_000).toISOString() });
  await request(app)
    .post(`/api/v1/auctions/${auctionId}/start`)
    .set('Authorization', `Bearer ${sellerToken}`);

  return auctionId;
}

function placeBid(auctionId: string, token: string, amountCents: number) {
  return request(app)
    .post(`/api/v1/auctions/${auctionId}/bids`)
    .set('Authorization', `Bearer ${token}`)
    .send({ amountCents, idempotencyKey: randomUUID() });
}

afterAll(async () => {
  await prisma.bid.deleteMany({ where: { auctionId: { in: createdAuctionIds } } });
  await prisma.auction.deleteMany({ where: { id: { in: createdAuctionIds } } });
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  await prisma.$disconnect();
});

describe('GET /api/v1/auctions/:auctionId/bids', () => {
  it('returns 404 for a nonexistent auction', async () => {
    const res = await request(app).get('/api/v1/auctions/00000000-0000-0000-0000-000000000000/bids');
    expect(res.status).toBe(404);
  });

  it("returns 404 for another seller's DRAFT auction (reuses auction visibility)", async () => {
    const seller = await registerAndLogin('seller');
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

    const res = await request(app).get(`/api/v1/auctions/${auctionId}/bids`);
    expect(res.status).toBe(404);
  });

  it('lists bids newest-first, anonymously, for a public auction', async () => {
    const seller = await registerAndLogin('seller');
    const bidder = await registerAndLogin('bidder');
    const auctionId = await createActiveAuction(seller.accessToken);

    const first = await placeBid(auctionId, bidder.accessToken, 1500);
    const second = await placeBid(auctionId, bidder.accessToken, 2000);

    const res = await request(app).get(`/api/v1/auctions/${auctionId}/bids`);
    expect(res.status).toBe(200);
    expect(res.body.bids).toHaveLength(2);
    // Newest (highest, since bids strictly increase — ADR-0011) first.
    expect(res.body.bids[0].id).toBe(second.body.bid.id);
    expect(res.body.bids[1].id).toBe(first.body.bid.id);
  });

  it('respects the limit query parameter', async () => {
    const seller = await registerAndLogin('seller');
    const bidder = await registerAndLogin('bidder');
    const auctionId = await createActiveAuction(seller.accessToken);

    await placeBid(auctionId, bidder.accessToken, 1500);
    await placeBid(auctionId, bidder.accessToken, 2000);
    await placeBid(auctionId, bidder.accessToken, 2500);

    const res = await request(app).get(`/api/v1/auctions/${auctionId}/bids`).query({ limit: 1 });
    expect(res.status).toBe(200);
    expect(res.body.bids).toHaveLength(1);
    expect(res.body.bids[0].amountCents).toBe(2500);
  });

  it('returns an empty list for an auction with no bids yet', async () => {
    const seller = await registerAndLogin('seller');
    const auctionId = await createActiveAuction(seller.accessToken);

    const res = await request(app).get(`/api/v1/auctions/${auctionId}/bids`);
    expect(res.status).toBe(200);
    expect(res.body.bids).toEqual([]);
  });
});
