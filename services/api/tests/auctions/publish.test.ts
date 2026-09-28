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
  const email = `test-auction-publish-${runId}-${counter}-${label}@example.com`;
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
  return res.body.auction as { id: string; sellerId: string };
}

afterAll(async () => {
  await prisma.auction.deleteMany({ where: { id: { in: createdAuctionIds } } });
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  await prisma.$disconnect();
});

describe('POST /api/v1/auctions/:id/publish', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(app).post('/api/v1/auctions/whatever/publish').send({});
    expect(res.status).toBe(401);
  });

  it('returns 404 for a nonexistent auction', async () => {
    const { accessToken } = await registerAndLogin();
    const res = await request(app)
      .post('/api/v1/auctions/00000000-0000-0000-0000-000000000000/publish')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ endTime: new Date(Date.now() + 3_600_000).toISOString() });
    expect(res.status).toBe(404);
  });

  it("returns 404 when a non-owner tries to publish someone else's draft", async () => {
    const owner = await registerAndLogin();
    const intruder = await registerAndLogin();
    const draft = await createDraftAuction(owner.accessToken);

    const res = await request(app)
      .post(`/api/v1/auctions/${draft.id}/publish`)
      .set('Authorization', `Bearer ${intruder.accessToken}`)
      .send({ endTime: new Date(Date.now() + 3_600_000).toISOString() });

    expect(res.status).toBe(404);
  });

  it('rejects publishing without a resolvable endTime', async () => {
    const { accessToken } = await registerAndLogin();
    const auction = await createDraftAuction(accessToken);

    const res = await request(app)
      .post(`/api/v1/auctions/${auction.id}/publish`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.details.endTime).toBeDefined();
  });

  it('rejects an endTime in the past', async () => {
    const { accessToken } = await registerAndLogin();
    const auction = await createDraftAuction(accessToken);

    const res = await request(app)
      .post(`/api/v1/auctions/${auction.id}/publish`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ endTime: new Date(Date.now() - 60_000).toISOString() });

    expect(res.status).toBe(400);
  });

  it('publishes a DRAFT auction with a valid endTime, defaulting startTime to now', async () => {
    const { accessToken } = await registerAndLogin();
    const auction = await createDraftAuction(accessToken);
    const endTime = new Date(Date.now() + 3_600_000);

    const before = Date.now();
    const res = await request(app)
      .post(`/api/v1/auctions/${auction.id}/publish`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ endTime: endTime.toISOString() });
    const after = Date.now();

    expect(res.status).toBe(200);
    expect(res.body.auction.status).toBe('PUBLISHED');
    expect(new Date(res.body.auction.endTime).getTime()).toBe(endTime.getTime());
    const startTimeMs = new Date(res.body.auction.startTime).getTime();
    expect(startTimeMs).toBeGreaterThanOrEqual(before - 1000);
    expect(startTimeMs).toBeLessThanOrEqual(after + 1000);
  });

  it('uses a previously-set schedule from an update if publish supplies none', async () => {
    const { accessToken } = await registerAndLogin();
    const auction = await createDraftAuction(accessToken);
    const startTime = new Date(Date.now() + 60_000);
    const endTime = new Date(Date.now() + 3_600_000);

    await request(app)
      .patch(`/api/v1/auctions/${auction.id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ startTime: startTime.toISOString(), endTime: endTime.toISOString() });

    const res = await request(app)
      .post(`/api/v1/auctions/${auction.id}/publish`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});

    expect(res.status).toBe(200);
    expect(new Date(res.body.auction.startTime).getTime()).toBe(startTime.getTime());
    expect(new Date(res.body.auction.endTime).getTime()).toBe(endTime.getTime());
  });

  it('rejects publishing an auction that is already published', async () => {
    const { accessToken } = await registerAndLogin();
    const auction = await createDraftAuction(accessToken);

    const first = await request(app)
      .post(`/api/v1/auctions/${auction.id}/publish`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ endTime: new Date(Date.now() + 3_600_000).toISOString() });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/v1/auctions/${auction.id}/publish`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ endTime: new Date(Date.now() + 7_200_000).toISOString() });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('AUCTION_NOT_PUBLISHABLE');
  });

  it('once published, the auction is also no longer editable via PATCH', async () => {
    const { accessToken } = await registerAndLogin();
    const auction = await createDraftAuction(accessToken);

    await request(app)
      .post(`/api/v1/auctions/${auction.id}/publish`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ endTime: new Date(Date.now() + 3_600_000).toISOString() });

    const res = await request(app)
      .patch(`/api/v1/auctions/${auction.id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ title: 'Too Late' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AUCTION_NOT_EDITABLE');
  });
});
