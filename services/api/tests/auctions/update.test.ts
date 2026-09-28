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
  const email = `test-auction-update-${runId}-${counter}-${label}@example.com`;
  testEmails.push(email);
  return email;
}

async function registerAndLogin() {
  const email = uniqueEmail('seller');
  const password = 'correct-horse-battery';
  await request(app).post('/api/v1/auth/register').send({ email, password, name: 'Seller Test' });
  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { userId: user.id, accessToken: loginRes.body.accessToken as string };
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
  return res.body.auction as { id: string; sellerId: string; reservePriceCents: number | null };
}

afterAll(async () => {
  await prisma.auction.deleteMany({ where: { id: { in: createdAuctionIds } } });
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  await prisma.$disconnect();
});

describe('PATCH /api/v1/auctions/:id', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(app).patch('/api/v1/auctions/whatever').send({ title: 'New Title' });
    expect(res.status).toBe(401);
  });

  it('returns 404 for a nonexistent auction', async () => {
    const { accessToken } = await registerAndLogin();
    const res = await request(app)
      .patch('/api/v1/auctions/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ title: 'New Title' });
    expect(res.status).toBe(404);
  });

  it("returns 404 for another seller's draft (invisible, not just unauthorized)", async () => {
    const owner = await registerAndLogin();
    const intruder = await registerAndLogin();
    const draft = await createDraftAuction(owner.accessToken);

    const res = await request(app)
      .patch(`/api/v1/auctions/${draft.id}`)
      .set('Authorization', `Bearer ${intruder.accessToken}`)
      .send({ title: 'Hijacked' });

    expect(res.status).toBe(404);
  });

  it('returns 403 for a non-owner editing a PUBLISHED (publicly visible) auction', async () => {
    const owner = await registerAndLogin();
    const intruder = await registerAndLogin();
    const auction = await createDraftAuction(owner.accessToken);
    await prisma.auction.update({
      where: { id: auction.id },
      data: { status: 'PUBLISHED', startTime: new Date(), endTime: new Date(Date.now() + 3_600_000) },
    });

    const res = await request(app)
      .patch(`/api/v1/auctions/${auction.id}`)
      .set('Authorization', `Bearer ${intruder.accessToken}`)
      .send({ title: 'Hijacked' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('lets the owner edit their own DRAFT auction', async () => {
    const { accessToken } = await registerAndLogin();
    const auction = await createDraftAuction(accessToken);

    const res = await request(app)
      .patch(`/api/v1/auctions/${auction.id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ title: 'Updated Title', startingPriceCents: 2000 });

    expect(res.status).toBe(200);
    expect(res.body.auction.title).toBe('Updated Title');
    expect(res.body.auction.startingPriceCents).toBe(2000);

    const stored = await prisma.auction.findUniqueOrThrow({ where: { id: auction.id } });
    expect(stored.title).toBe('Updated Title');
  });

  it('rejects a patch that would make the reserve lower than the (unchanged) starting price', async () => {
    const { accessToken } = await registerAndLogin();
    const auction = await createDraftAuction(accessToken, { startingPriceCents: 5000 });

    const res = await request(app)
      .patch(`/api/v1/auctions/${auction.id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ reservePriceCents: 1000 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('clears an existing reserve price when reservePriceCents is explicitly set to null', async () => {
    const { accessToken } = await registerAndLogin();
    const auction = await createDraftAuction(accessToken, {
      startingPriceCents: 1000,
      reservePriceCents: 1500,
    });
    expect(auction.reservePriceCents).toBe(1500);

    const res = await request(app)
      .patch(`/api/v1/auctions/${auction.id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ reservePriceCents: null });

    expect(res.status).toBe(200);
    expect(res.body.auction.reservePriceCents).toBeNull();
  });

  it('rejects editing an auction that is no longer DRAFT', async () => {
    const { accessToken } = await registerAndLogin();
    const auction = await createDraftAuction(accessToken);
    await prisma.auction.update({
      where: { id: auction.id },
      data: { status: 'PUBLISHED', startTime: new Date(), endTime: new Date(Date.now() + 3_600_000) },
    });

    const res = await request(app)
      .patch(`/api/v1/auctions/${auction.id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ title: 'Too Late' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AUCTION_NOT_EDITABLE');
  });
});
