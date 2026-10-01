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
  const email = `test-auction-update-${runId}-${counter}-${label}@example.com`.toLowerCase();
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
  // Bid.auction is onDelete: Restrict (ADR-0007) — the new price-regression
  // test below places a real bid, so it must be cleared first.
  await prisma.bid.deleteMany({ where: { auctionId: { in: createdAuctionIds } } });
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
    // Regression (found live, 2026-09-29): currentPriceCents must track
    // startingPriceCents while still DRAFT — a DRAFT can never have a real
    // bid yet, so "the price to beat" is always exactly the starting
    // price until the first bid. Left stale, this let a bid far below the
    // seller's actual intended price win after publish.
    expect(res.body.auction.currentPriceCents).toBe(2000);

    const stored = await prisma.auction.findUniqueOrThrow({ where: { id: auction.id } });
    expect(stored.title).toBe('Updated Title');
    expect(stored.currentPriceCents).toBe(2000);
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

  // Full end-to-end proof of the currentPriceCents regression above, not
  // just checking the stored column — created because the create-auction
  // frontend flow now creates a DRAFT with a nominal placeholder price and
  // edits it to a real one before publishing (app/auctions/[id]/
  // SetPriceAndPublishPanel.tsx), which is exactly the sequence that
  // surfaced this bug live: a bid was able to win far below the seller's
  // real intended price because bid validation trusts currentPriceCents,
  // not startingPriceCents.
  it('a bid below the EDITED price is rejected after publish, even though it would have cleared the original placeholder price', async () => {
    const seller = await registerAndLogin();
    const bidder = await registerAndLogin();
    const auction = await createDraftAuction(seller.accessToken, { startingPriceCents: 100 });

    await request(app)
      .patch(`/api/v1/auctions/${auction.id}`)
      .set('Authorization', `Bearer ${seller.accessToken}`)
      .send({ startingPriceCents: 250_000 });

    await request(app)
      .post(`/api/v1/auctions/${auction.id}/publish`)
      .set('Authorization', `Bearer ${seller.accessToken}`)
      .send({ endTime: new Date(Date.now() + 3_600_000).toISOString() });
    await request(app)
      .post(`/api/v1/auctions/${auction.id}/start`)
      .set('Authorization', `Bearer ${seller.accessToken}`);

    const lowBid = await request(app)
      .post(`/api/v1/auctions/${auction.id}/bids`)
      .set('Authorization', `Bearer ${bidder.accessToken}`)
      .send({ amountCents: 150, idempotencyKey: randomUUID() });
    expect(lowBid.status).toBe(400);

    const realBid = await request(app)
      .post(`/api/v1/auctions/${auction.id}/bids`)
      .set('Authorization', `Bearer ${bidder.accessToken}`)
      .send({ amountCents: 250_001, idempotencyKey: randomUUID() });
    expect(realBid.status).toBe(201);
  });
});
