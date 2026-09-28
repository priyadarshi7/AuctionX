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
  const email = `test-ai-valuation-${runId}-${counter}-${label}@example.com`;
  testEmails.push(email);
  return email;
}

async function registerAndLogin() {
  const email = uniqueEmail('seller');
  const password = 'correct-horse-battery';
  await request(app).post('/api/v1/auth/register').send({ email, password, name: 'Seller Test' });
  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
  return { accessToken: loginRes.body.accessToken as string };
}

async function createDraftAuction(accessToken: string) {
  const res = await request(app)
    .post('/api/v1/auctions')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      title: 'Test Lot',
      description: 'A test lot.',
      category: 'OTHER',
      condition: 'GOOD',
      startingPriceCents: 1000,
    });
  createdAuctionIds.push(res.body.auction.id);
  return res.body.auction as { id: string };
}

afterAll(async () => {
  await prisma.auction.deleteMany({ where: { id: { in: createdAuctionIds } } });
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  await prisma.$disconnect();
});

describe('GET /api/v1/auctions/:auctionId/valuation', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/v1/auctions/whatever/valuation');
    expect(res.status).toBe(401);
  });

  it("returns 404 for another seller's draft (invisible, same rule as auctions/service.ts)", async () => {
    const owner = await registerAndLogin();
    const intruder = await registerAndLogin();
    const auction = await createDraftAuction(owner.accessToken);

    const res = await request(app)
      .get(`/api/v1/auctions/${auction.id}/valuation`)
      .set('Authorization', `Bearer ${intruder.accessToken}`);

    expect(res.status).toBe(404);
  });

  it('returns 403 for a non-owner viewing a PUBLISHED auction\'s valuation', async () => {
    const owner = await registerAndLogin();
    const intruder = await registerAndLogin();
    const auction = await createDraftAuction(owner.accessToken);
    await prisma.auction.update({
      where: { id: auction.id },
      data: { status: 'PUBLISHED', startTime: new Date(), endTime: new Date(Date.now() + 3_600_000) },
    });

    const res = await request(app)
      .get(`/api/v1/auctions/${auction.id}/valuation`)
      .set('Authorization', `Bearer ${intruder.accessToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('is already PENDING immediately after auction creation, with no separate trigger call', async () => {
    const { accessToken } = await registerAndLogin();
    const auction = await createDraftAuction(accessToken);

    const res = await request(app)
      .get(`/api/v1/auctions/${auction.id}/valuation`)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.estimatedValueCents).toBeNull();
  });

  it('lazily creates a PENDING valuation for a pre-existing auction with no row yet', async () => {
    const { accessToken } = await registerAndLogin();
    const auction = await createDraftAuction(accessToken);
    // Simulates an auction created before this feature existed — the row
    // createAuction normally writes atomically is deleted directly, same
    // as ADR-0031's "Hello" auction that predated search reindexing.
    await prisma.auctionValuation.delete({ where: { auctionId: auction.id } });

    const res = await request(app)
      .get(`/api/v1/auctions/${auction.id}/valuation`)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PENDING');

    const stored = await prisma.auctionValuation.findUniqueOrThrow({ where: { auctionId: auction.id } });
    expect(stored.status).toBe('PENDING');
  });
});

describe('POST /api/v1/auctions/:auctionId/valuation/regenerate', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(app).post('/api/v1/auctions/whatever/valuation/regenerate');
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-owner', async () => {
    const owner = await registerAndLogin();
    const intruder = await registerAndLogin();
    const auction = await createDraftAuction(owner.accessToken);
    await prisma.auction.update({
      where: { id: auction.id },
      data: { status: 'PUBLISHED', startTime: new Date(), endTime: new Date(Date.now() + 3_600_000) },
    });

    const res = await request(app)
      .post(`/api/v1/auctions/${auction.id}/valuation/regenerate`)
      .set('Authorization', `Bearer ${intruder.accessToken}`);

    expect(res.status).toBe(403);
  });

  it('resets a COMPLETE valuation back to PENDING, clearing prior results', async () => {
    const { accessToken } = await registerAndLogin();
    const auction = await createDraftAuction(accessToken);
    await prisma.auctionValuation.update({
      where: { auctionId: auction.id },
      data: {
        status: 'COMPLETE',
        estimatedValueCents: 5000,
        priceRangeLowCents: 4000,
        priceRangeHighCents: 6000,
        confidence: 0.5,
        explanation: 'Stale result from a prior run.',
        model: 'moondream',
      },
    });

    const res = await request(app)
      .post(`/api/v1/auctions/${auction.id}/valuation/regenerate`)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.estimatedValueCents).toBeNull();
    expect(res.body.explanation).toBeNull();
  });
});
