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
  const email = `test-delete-account-${runId}-${counter}-${label}@example.com`.toLowerCase();
  testEmails.push(email);
  return email;
}

async function registerAndLogin(label: string) {
  const email = uniqueEmail(label);
  const password = 'correct-horse-battery';
  await request(app).post('/api/v1/auth/register').send({ email, password, name: 'Delete Test' });
  await prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { email, userId: user.id, accessToken: loginRes.body.accessToken as string };
}

async function createDraftAuction(sellerToken: string) {
  const res = await request(app)
    .post('/api/v1/auctions')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({
      title: 'Delete Account Test Lot',
      description: 'A lot for delete-account testing.',
      category: 'OTHER',
      condition: 'GOOD',
      startingPriceCents: 1000,
    });
  const auctionId = res.body.auction.id as string;
  createdAuctionIds.push(auctionId);
  return auctionId;
}

async function createActiveAuctionAndBid(sellerToken: string, bidderToken: string) {
  const auctionId = await createDraftAuction(sellerToken);
  await request(app)
    .post(`/api/v1/auctions/${auctionId}/publish`)
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ endTime: new Date(Date.now() + 3_600_000).toISOString() });
  await request(app)
    .post(`/api/v1/auctions/${auctionId}/start`)
    .set('Authorization', `Bearer ${sellerToken}`);
  await request(app)
    .post(`/api/v1/auctions/${auctionId}/bids`)
    .set('Authorization', `Bearer ${bidderToken}`)
    .send({ amountCents: 1500, idempotencyKey: randomUUID() });
  return auctionId;
}

afterAll(async () => {
  await prisma.bid.deleteMany({ where: { auctionId: { in: createdAuctionIds } } });
  await prisma.auction.deleteMany({ where: { id: { in: createdAuctionIds } } });
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  await prisma.$disconnect();
});

describe('DELETE /api/v1/auth/me', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(app).delete('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('deletes a clean account (no bids or orders)', async () => {
    const { email, userId, accessToken } = await registerAndLogin('clean');

    const res = await request(app)
      .delete('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(204);

    const row = await prisma.user.findUnique({ where: { id: userId } });
    expect(row).toBeNull();

    // Already gone — don't let afterAll's cleanup try to delete it again
    // (deleteMany on a missing row is a harmless no-op, but this keeps the
    // test's own intent explicit: this email is already fully cleaned up).
    testEmails.splice(testEmails.indexOf(email), 1);
  });

  it('clears the refresh cookie on successful deletion', async () => {
    const { accessToken } = await registerAndLogin('cookie');

    const res = await request(app)
      .delete('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);

    const setCookieHeader = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    const cleared = cookies.find((c: string) => c?.startsWith('refreshToken='));
    expect(cleared).toBeDefined();
    expect(cleared).toMatch(/refreshToken=;/);
  });

  // The important distinction this feature hinges on: owning an auction
  // row is NOT by itself "history" — only a bid or order is. A DRAFT
  // auction (never published, never biddable) must not block deletion,
  // and deleting the account should take the never-bid-on auction with it
  // rather than leave an orphaned row.
  it('deletes an account that owns a DRAFT auction, and deletes the auction with it', async () => {
    const { userId, accessToken } = await registerAndLogin('has-draft');
    const auctionId = await createDraftAuction(accessToken);

    const res = await request(app)
      .delete('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(204);

    const userRow = await prisma.user.findUnique({ where: { id: userId } });
    expect(userRow).toBeNull();
    const auctionRow = await prisma.auction.findUnique({ where: { id: auctionId } });
    expect(auctionRow).toBeNull();
  });

  it('refuses to delete an account that has placed a bid, and leaves everything untouched', async () => {
    const seller = await registerAndLogin('seller-for-bidder-block');
    const bidder = await registerAndLogin('has-placed-bid');
    const auctionId = await createActiveAuctionAndBid(seller.accessToken, bidder.accessToken);

    const res = await request(app)
      .delete('/api/v1/auth/me')
      .set('Authorization', `Bearer ${bidder.accessToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ACCOUNT_HAS_HISTORY');

    const bidderRow = await prisma.user.findUnique({ where: { id: bidder.userId } });
    expect(bidderRow).not.toBeNull();
    const auctionRow = await prisma.auction.findUnique({ where: { id: auctionId } });
    expect(auctionRow).not.toBeNull();
  });

  it('refuses to delete a seller whose own auction received a bid from someone else', async () => {
    const seller = await registerAndLogin('seller-has-received-bid');
    const bidder = await registerAndLogin('bidder-for-seller-block');
    await createActiveAuctionAndBid(seller.accessToken, bidder.accessToken);

    const res = await request(app)
      .delete('/api/v1/auth/me')
      .set('Authorization', `Bearer ${seller.accessToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ACCOUNT_HAS_HISTORY');

    const sellerRow = await prisma.user.findUnique({ where: { id: seller.userId } });
    expect(sellerRow).not.toBeNull();
  });
});
