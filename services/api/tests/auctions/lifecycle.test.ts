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
  const email = `test-auction-lifecycle-${runId}-${counter}-${label}@example.com`;
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

async function publishAuction(accessToken: string, id: string, endTime = new Date(Date.now() + 3_600_000)) {
  const res = await request(app)
    .post(`/api/v1/auctions/${id}/publish`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ endTime: endTime.toISOString() });
  return res.body.auction;
}

afterAll(async () => {
  await prisma.auction.deleteMany({ where: { id: { in: createdAuctionIds } } });
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  await prisma.$disconnect();
});

describe('POST /api/v1/auctions/:id/start', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(app).post('/api/v1/auctions/whatever/start').send({});
    expect(res.status).toBe(401);
  });

  it('returns 404 for a nonexistent auction', async () => {
    const { accessToken } = await registerAndLogin();
    const res = await request(app)
      .post('/api/v1/auctions/00000000-0000-0000-0000-000000000000/start')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});
    expect(res.status).toBe(404);
  });

  it('rejects starting a DRAFT auction (not yet published)', async () => {
    const { accessToken } = await registerAndLogin();
    const draft = await createDraftAuction(accessToken);

    const res = await request(app)
      .post(`/api/v1/auctions/${draft.id}/start`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AUCTION_NOT_STARTABLE');
  });

  it('starts a PUBLISHED auction', async () => {
    const { accessToken } = await registerAndLogin();
    const draft = await createDraftAuction(accessToken);
    await publishAuction(accessToken, draft.id);

    const res = await request(app)
      .post(`/api/v1/auctions/${draft.id}/start`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.auction.status).toBe('ACTIVE');
  });

  it('rejects starting a PUBLISHED auction whose scheduled end has already passed', async () => {
    const { accessToken } = await registerAndLogin();
    const draft = await createDraftAuction(accessToken);
    // publish requires a future endTime, so schedule near-future then let it lapse
    await publishAuction(accessToken, draft.id, new Date(Date.now() + 500));
    await new Promise((resolve) => setTimeout(resolve, 700));

    const res = await request(app)
      .post(`/api/v1/auctions/${draft.id}/start`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AUCTION_SCHEDULE_EXPIRED');
  });

  it('resumes a PAUSED auction back to ACTIVE', async () => {
    const { accessToken } = await registerAndLogin();
    const draft = await createDraftAuction(accessToken);
    await publishAuction(accessToken, draft.id);
    await request(app)
      .post(`/api/v1/auctions/${draft.id}/start`)
      .set('Authorization', `Bearer ${accessToken}`);
    await request(app)
      .post(`/api/v1/auctions/${draft.id}/pause`)
      .set('Authorization', `Bearer ${accessToken}`);

    const res = await request(app)
      .post(`/api/v1/auctions/${draft.id}/start`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.auction.status).toBe('ACTIVE');
  });

  it("returns 403 when a non-owner tries to start someone else's PUBLISHED auction", async () => {
    const owner = await registerAndLogin();
    const intruder = await registerAndLogin();
    const draft = await createDraftAuction(owner.accessToken);
    await publishAuction(owner.accessToken, draft.id);

    const res = await request(app)
      .post(`/api/v1/auctions/${draft.id}/start`)
      .set('Authorization', `Bearer ${intruder.accessToken}`)
      .send({});

    expect(res.status).toBe(403);
  });
});

describe('POST /api/v1/auctions/:id/pause', () => {
  it('rejects pausing an auction that is not ACTIVE', async () => {
    const { accessToken } = await registerAndLogin();
    const draft = await createDraftAuction(accessToken);
    await publishAuction(accessToken, draft.id);

    const res = await request(app)
      .post(`/api/v1/auctions/${draft.id}/pause`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AUCTION_NOT_PAUSABLE');
  });

  it('pauses an ACTIVE auction', async () => {
    const { accessToken } = await registerAndLogin();
    const draft = await createDraftAuction(accessToken);
    await publishAuction(accessToken, draft.id);
    await request(app)
      .post(`/api/v1/auctions/${draft.id}/start`)
      .set('Authorization', `Bearer ${accessToken}`);

    const res = await request(app)
      .post(`/api/v1/auctions/${draft.id}/pause`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.auction.status).toBe('PAUSED');
  });
});

describe('POST /api/v1/auctions/:id/cancel', () => {
  it.each(['DRAFT', 'PUBLISHED', 'ACTIVE', 'PAUSED'])(
    'cancels an auction in %s status and records endedAt',
    async (status) => {
      const { accessToken } = await registerAndLogin();
      const draft = await createDraftAuction(accessToken);

      if (status !== 'DRAFT') {
        await publishAuction(accessToken, draft.id);
      }
      if (status === 'ACTIVE' || status === 'PAUSED') {
        await request(app)
          .post(`/api/v1/auctions/${draft.id}/start`)
          .set('Authorization', `Bearer ${accessToken}`);
      }
      if (status === 'PAUSED') {
        await request(app)
          .post(`/api/v1/auctions/${draft.id}/pause`)
          .set('Authorization', `Bearer ${accessToken}`);
      }

      const res = await request(app)
        .post(`/api/v1/auctions/${draft.id}/cancel`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.auction.status).toBe('CANCELLED');
      expect(res.body.auction.endedAt).not.toBeNull();
    },
  );

  it('rejects cancelling an auction that is already CANCELLED', async () => {
    const { accessToken } = await registerAndLogin();
    const draft = await createDraftAuction(accessToken);
    await request(app)
      .post(`/api/v1/auctions/${draft.id}/cancel`)
      .set('Authorization', `Bearer ${accessToken}`);

    const res = await request(app)
      .post(`/api/v1/auctions/${draft.id}/cancel`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AUCTION_NOT_CANCELLABLE');
  });

  it('rejects cancelling an ENDED auction', async () => {
    const { accessToken } = await registerAndLogin();
    const draft = await createDraftAuction(accessToken);
    // "end" isn't implemented yet (Phase 4 territory) — force the state
    // directly to exercise the terminal-state guard.
    await prisma.auction.update({ where: { id: draft.id }, data: { status: 'ENDED', endedAt: new Date() } });

    const res = await request(app)
      .post(`/api/v1/auctions/${draft.id}/cancel`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AUCTION_NOT_CANCELLABLE');
  });

  it("returns 404 when a non-owner tries to cancel someone else's DRAFT", async () => {
    const owner = await registerAndLogin();
    const intruder = await registerAndLogin();
    const draft = await createDraftAuction(owner.accessToken);

    const res = await request(app)
      .post(`/api/v1/auctions/${draft.id}/cancel`)
      .set('Authorization', `Bearer ${intruder.accessToken}`)
      .send({});

    expect(res.status).toBe(404);
  });
});
