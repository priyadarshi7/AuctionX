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
  const email = `test-auction-create-${runId}-${counter}-${label}@example.com`.toLowerCase();
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

const validPayload = {
  title: 'Vintage Pocket Watch',
  description: 'A well-preserved 19th century pocket watch.',
  category: 'WATCHES',
  condition: 'GOOD',
  startingPriceCents: 5000,
};

afterAll(async () => {
  await prisma.auction.deleteMany({ where: { id: { in: createdAuctionIds } } });
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  await prisma.$disconnect();
});

describe('POST /api/v1/auctions', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(app).post('/api/v1/auctions').send(validPayload);
    expect(res.status).toBe(401);
  });

  it('creates a DRAFT auction owned by the authenticated caller', async () => {
    const { userId, accessToken } = await registerAndLogin();

    const res = await request(app)
      .post('/api/v1/auctions')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(validPayload);

    expect(res.status).toBe(201);
    createdAuctionIds.push(res.body.auction.id);

    expect(res.body.auction).toMatchObject({
      sellerId: userId,
      title: validPayload.title,
      status: 'DRAFT',
      startingPriceCents: 5000,
      // No bid exists yet — current price starts equal to the starting price.
      currentPriceCents: 5000,
      images: [],
    });

    const stored = await prisma.auction.findUniqueOrThrow({ where: { id: res.body.auction.id } });
    expect(stored.sellerId).toBe(userId);
    expect(stored.status).toBe('DRAFT');
  });

  it('ignores client-supplied status/sellerId/currentPriceCents — the server decides those', async () => {
    const { userId, accessToken } = await registerAndLogin();
    const otherUserId = '00000000-0000-0000-0000-000000000000';

    const res = await request(app)
      .post('/api/v1/auctions')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        ...validPayload,
        status: 'ACTIVE',
        sellerId: otherUserId,
        currentPriceCents: 999999,
      });

    expect(res.status).toBe(201);
    createdAuctionIds.push(res.body.auction.id);
    expect(res.body.auction.status).toBe('DRAFT');
    expect(res.body.auction.sellerId).toBe(userId);
    expect(res.body.auction.currentPriceCents).toBe(validPayload.startingPriceCents);
  });

  it('rejects an invalid payload with a structured 400', async () => {
    const { accessToken } = await registerAndLogin();

    const res = await request(app)
      .post('/api/v1/auctions')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ title: '', description: '', category: 'NOT_A_CATEGORY', startingPriceCents: -5 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a reserve price below the starting price', async () => {
    const { accessToken } = await registerAndLogin();

    const res = await request(app)
      .post('/api/v1/auctions')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ...validPayload, startingPriceCents: 5000, reservePriceCents: 4000 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('accepts a reserve price at or above the starting price', async () => {
    const { accessToken } = await registerAndLogin();

    const res = await request(app)
      .post('/api/v1/auctions')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ...validPayload, startingPriceCents: 5000, reservePriceCents: 5000 });

    expect(res.status).toBe(201);
    createdAuctionIds.push(res.body.auction.id);
    expect(res.body.auction.reservePriceCents).toBe(5000);
  });
});
