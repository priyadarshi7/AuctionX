import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { hashPassword } from '../../src/infrastructure/security/password';

const app = createApp();

const runId = Date.now();
let counter = 0;
const testEmails: string[] = [];
const createdAuctionIds: string[] = [];

function uniqueEmail(label: string): string {
  counter += 1;
  const email = `test-auction-list-${runId}-${counter}-${label}@example.com`.toLowerCase();
  testEmails.push(email);
  return email;
}

async function registerAndLogin() {
  const email = uniqueEmail('seller');
  const password = 'correct-horse-battery';
  await request(app).post('/api/v1/auth/register').send({ email, password, name: 'Seller Test' });
  await prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { userId: user.id, accessToken: loginRes.body.accessToken as string };
}

async function createAdmin() {
  const email = uniqueEmail('admin');
  const password = 'correct-horse-battery';
  await prisma.user.create({
    data: { email, passwordHash: await hashPassword(password), name: 'Admin Test', role: 'ADMIN' },
  });
  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
  return loginRes.body.accessToken as string;
}

async function createDraftAuction(accessToken: string, overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/api/v1/auctions')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      title: 'Test Lot',
      description: 'A test lot.',
      category: 'OTHER',
      condition: 'GOOD',
      startingPriceCents: 1000,
      ...overrides,
    });
  createdAuctionIds.push(res.body.auction.id);
  return res.body.auction as { id: string; sellerId: string };
}

// publish/lifecycle actions don't exist yet (a later task) — flipping status
// directly via Prisma is the only way to get a non-DRAFT row for these tests.
async function forcePublished(auctionId: string, overrides: Record<string, unknown> = {}) {
  return prisma.auction.update({ where: { id: auctionId }, data: { status: 'PUBLISHED', ...overrides } });
}

afterAll(async () => {
  await prisma.auction.deleteMany({ where: { id: { in: createdAuctionIds } } });
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  await prisma.$disconnect();
});

describe('GET /api/v1/auctions', () => {
  it('excludes DRAFT auctions from an anonymous listing', async () => {
    const seller = await registerAndLogin();
    const draft = await createDraftAuction(seller.accessToken);
    const published = await createDraftAuction(seller.accessToken);
    await forcePublished(published.id);

    const res = await request(app).get('/api/v1/auctions');
    expect(res.status).toBe(200);
    const ids = res.body.auctions.map((a: { id: string }) => a.id);
    expect(ids).toContain(published.id);
    expect(ids).not.toContain(draft.id);
  });

  it('an explicit status=DRAFT filter from a non-owner returns an empty page, not an error', async () => {
    const seller = await registerAndLogin();
    await createDraftAuction(seller.accessToken);

    const res = await request(app).get('/api/v1/auctions').query({ status: 'DRAFT' });
    expect(res.status).toBe(200);
    expect(res.body.auctions).toEqual([]);
  });

  it("includes the caller's own drafts when filtering by their own sellerId", async () => {
    const seller = await registerAndLogin();
    const draft = await createDraftAuction(seller.accessToken);

    const res = await request(app)
      .get('/api/v1/auctions')
      .query({ sellerId: seller.userId, status: 'DRAFT' })
      .set('Authorization', `Bearer ${seller.accessToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.auctions.map((a: { id: string }) => a.id);
    expect(ids).toContain(draft.id);
  });

  it("excludes another seller's drafts even when directly filtering by their sellerId", async () => {
    const sellerA = await registerAndLogin();
    const sellerB = await registerAndLogin();
    const draft = await createDraftAuction(sellerA.accessToken);

    const res = await request(app)
      .get('/api/v1/auctions')
      .query({ sellerId: sellerA.userId, status: 'DRAFT' })
      .set('Authorization', `Bearer ${sellerB.accessToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.auctions.map((a: { id: string }) => a.id);
    expect(ids).not.toContain(draft.id);
  });

  it('an admin can see any draft', async () => {
    const seller = await registerAndLogin();
    const adminToken = await createAdmin();
    const draft = await createDraftAuction(seller.accessToken);

    const res = await request(app)
      .get('/api/v1/auctions')
      .query({ sellerId: seller.userId, status: 'DRAFT' })
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.auctions.map((a: { id: string }) => a.id);
    expect(ids).toContain(draft.id);
  });

  it('paginates without skipping or duplicating rows across pages', async () => {
    const seller = await registerAndLogin();
    const ids: string[] = [];

    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- deliberately sequential so createdAt ordering is deterministic
      const auction = await createDraftAuction(seller.accessToken, { title: `Lot ${i}` });
      // eslint-disable-next-line no-await-in-loop
      await forcePublished(auction.id);
      ids.push(auction.id);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const res = await request(app)
        .get('/api/v1/auctions')
        .query({ sellerId: seller.userId, limit: 2, ...(cursor ? { cursor } : {}) });
      expect(res.status).toBe(200);
      seen.push(...res.body.auctions.map((a: { id: string }) => a.id));
      cursor = res.body.nextCursor ?? undefined;
      if (!cursor) break;
    }

    // Every created id shows up exactly once across all pages combined.
    expect(seen.sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('rejects a corrupted cursor with a structured 400', async () => {
    const res = await request(app).get('/api/v1/auctions').query({ cursor: 'not-a-real-cursor' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/v1/auctions/:id', () => {
  it('returns 404 for a nonexistent auction', async () => {
    const res = await request(app).get('/api/v1/auctions/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it("returns 404 for another seller's DRAFT auction, indistinguishable from nonexistent", async () => {
    const seller = await registerAndLogin();
    const draft = await createDraftAuction(seller.accessToken);

    const res = await request(app).get(`/api/v1/auctions/${draft.id}`);
    expect(res.status).toBe(404);
  });

  it('returns the DRAFT auction to its own seller', async () => {
    const seller = await registerAndLogin();
    const draft = await createDraftAuction(seller.accessToken);

    const res = await request(app)
      .get(`/api/v1/auctions/${draft.id}`)
      .set('Authorization', `Bearer ${seller.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.auction.id).toBe(draft.id);
  });

  it('returns a PUBLISHED auction to anyone', async () => {
    const seller = await registerAndLogin();
    const auction = await createDraftAuction(seller.accessToken);
    await forcePublished(auction.id);

    const res = await request(app).get(`/api/v1/auctions/${auction.id}`);
    expect(res.status).toBe(200);
    expect(res.body.auction.id).toBe(auction.id);
  });
});
