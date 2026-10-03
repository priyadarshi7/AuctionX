import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { hashPassword } from '../../src/infrastructure/security/password';
import { currentReviewMode, requiresDocuments, requiresReview } from '../../src/modules/auctions/reviewPolicy';

const app = createApp();

const runId = Date.now();
let counter = 0;
const testEmails: string[] = [];
const createdAuctionIds: string[] = [];
const PASSWORD = 'correct-horse-battery';

function uniqueEmail(label: string): string {
  counter += 1;
  const email = `test-review-${runId}-${counter}-${label}@example.com`.toLowerCase();
  testEmails.push(email);
  return email;
}

async function createAdmin() {
  const email = uniqueEmail('admin');
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashPassword(PASSWORD), name: 'Admin', role: 'ADMIN', emailVerifiedAt: new Date() },
  });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { id: user.id, accessToken: login.body.accessToken as string };
}

async function createUser(label: string, extra: { trustedSeller?: boolean } = {}) {
  const email = uniqueEmail(label);
  await request(app).post('/api/v1/auth/register').send({ email, password: PASSWORD, name: label });
  const user = await prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date(), ...extra } });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { id: user.id, accessToken: login.body.accessToken as string };
}

async function createDraft(token: string, category = 'OTHER') {
  const res = await request(app)
    .post('/api/v1/auctions')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'Review Lot', description: 'desc', category, condition: 'GOOD', startingPriceCents: 1000 });
  const id = res.body.auction.id as string;
  createdAuctionIds.push(id);
  return id;
}

const submit = (token: string, id: string, durationSeconds = 60) =>
  request(app).post(`/api/v1/auctions/${id}/submit`).set('Authorization', `Bearer ${token}`).send({ durationSeconds });
const moderate = (token: string, id: string, body: Record<string, unknown>) =>
  request(app).post(`/api/v1/admin/auctions/${id}/moderate`).set('Authorization', `Bearer ${token}`).send(body);
const getAuction = (id: string, token?: string) => {
  const r = request(app).get(`/api/v1/auctions/${id}`);
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};

async function eventsFor(key: string, type: string) {
  const rows = await prisma.outboxEvent.findMany({ where: { key } });
  return rows.filter((r) => (r.payload as { type: string }).type === type);
}

// Review is OFF in the test environment by default (tests/jest.env.ts) so the
// many suites that publish auctions directly keep working; this file opts in.
beforeAll(() => {
  process.env.AUCTION_REVIEW_MODE = 'untrusted';
});

afterAll(async () => {
  process.env.AUCTION_REVIEW_MODE = 'off';
  await prisma.outboxEvent.deleteMany({ where: { key: { in: createdAuctionIds } } });
  await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: createdAuctionIds } } });
  const users = await prisma.user.findMany({ where: { email: { in: testEmails } }, select: { id: true } });
  await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: users.map((u) => u.id) } } });
  await prisma.bid.deleteMany({ where: { auctionId: { in: createdAuctionIds } } });
  await prisma.auction.deleteMany({ where: { id: { in: createdAuctionIds } } });
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  await prisma.$disconnect();
});

describe('review policy (pure)', () => {
  it('opted in for this file', () => {
    expect(currentReviewMode()).toBe('untrusted');
  });

  it('is never required when review is off', () => {
    expect(requiresReview('off', { trustedSeller: false }, 'WATCHES')).toBe(false);
  });

  it('requires review for an untrusted seller in any category', () => {
    expect(requiresReview('untrusted', { trustedSeller: false }, 'OTHER')).toBe(true);
  });

  it('lets a trusted seller skip review only for low-risk categories', () => {
    expect(requiresReview('untrusted', { trustedSeller: true }, 'OTHER')).toBe(false);
    for (const category of ['WATCHES', 'JEWELRY', 'ART', 'COINS_AND_CURRENCY'] as const) {
      expect(requiresReview('untrusted', { trustedSeller: true }, category)).toBe(true);
      expect(requiresDocuments(category)).toBe(true);
    }
    expect(requiresDocuments('OTHER')).toBe(false);
  });
});

describe('submitting for review', () => {
  it('holds an untrusted seller’s listing in PENDING_REVIEW, hidden from everyone but the seller and admins', async () => {
    const admin = await createAdmin();
    const seller = await createUser('seller');
    const stranger = await createUser('stranger');
    const id = await createDraft(seller.accessToken);

    const res = await submit(seller.accessToken, id, 120);
    expect(res.status).toBe(200);
    expect(res.body.auction).toMatchObject({ status: 'PENDING_REVIEW', requestedDurationSeconds: 120 });
    expect(res.body.auction.startTime).toBeNull();
    expect(res.body.auction.endTime).toBeNull();

    expect((await getAuction(id, seller.accessToken)).status).toBe(200);
    expect((await getAuction(id, admin.accessToken)).status).toBe(200);
    expect((await getAuction(id, stranger.accessToken)).status).toBe(404);
    expect((await getAuction(id)).status).toBe(404);

    const publicList = await request(app).get('/api/v1/auctions?limit=50');
    expect(publicList.body.auctions.map((a: { id: string }) => a.id)).not.toContain(id);
    const pendingFilter = await request(app).get('/api/v1/auctions?status=PENDING_REVIEW');
    expect(pendingFilter.body.auctions).toEqual([]);
    const ownList = await request(app)
      .get(`/api/v1/auctions?sellerId=${seller.id}`)
      .set('Authorization', `Bearer ${seller.accessToken}`);
    expect(ownList.body.auctions.map((a: { id: string }) => a.id)).toContain(id);
  });

  it('cannot be bypassed: publish is refused while review is required, and nothing can be bid on', async () => {
    const seller = await createUser('seller');
    const bidder = await createUser('bidder');
    const id = await createDraft(seller.accessToken);

    const publish = await request(app)
      .post(`/api/v1/auctions/${id}/publish`)
      .set('Authorization', `Bearer ${seller.accessToken}`)
      .send({ endTime: new Date(Date.now() + 3_600_000).toISOString() });
    expect(publish.status).toBe(409);
    expect(publish.body.error.code).toBe('REVIEW_REQUIRED');

    const start = await request(app).post(`/api/v1/auctions/${id}/start`).set('Authorization', `Bearer ${seller.accessToken}`);
    expect(start.status).toBe(409);

    await submit(seller.accessToken, id);
    const bid = await request(app)
      .post(`/api/v1/auctions/${id}/bids`)
      .set('Authorization', `Bearer ${bidder.accessToken}`)
      .send({ amountCents: 2000, idempotencyKey: randomUUID() });
    expect(bid.status).toBe(409);
    expect((await prisma.auction.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING_REVIEW');
  });

  it('is not editable while pending, cannot be submitted twice, and only the owner can submit', async () => {
    const seller = await createUser('seller');
    const stranger = await createUser('stranger');
    const id = await createDraft(seller.accessToken);
    expect((await submit(stranger.accessToken, id)).status).toBe(404);

    await submit(seller.accessToken, id);
    const edit = await request(app)
      .patch(`/api/v1/auctions/${id}`)
      .set('Authorization', `Bearer ${seller.accessToken}`)
      .send({ title: 'Sneaky edit after approval-pending' });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('AUCTION_NOT_EDITABLE');

    const again = await submit(seller.accessToken, id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('AUCTION_NOT_SUBMITTABLE');
    expect((await submit(seller.accessToken, id, 5)).status).toBe(400);
  });

  it('can be withdrawn back to DRAFT, edited, and resubmitted', async () => {
    const seller = await createUser('seller');
    const id = await createDraft(seller.accessToken);
    await submit(seller.accessToken, id);

    const withdraw = await request(app).post(`/api/v1/auctions/${id}/withdraw`).set('Authorization', `Bearer ${seller.accessToken}`);
    expect(withdraw.status).toBe(200);
    expect(withdraw.body.auction).toMatchObject({ status: 'DRAFT', requestedDurationSeconds: null, submittedAt: null });

    const again = await request(app).post(`/api/v1/auctions/${id}/withdraw`).set('Authorization', `Bearer ${seller.accessToken}`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('AUCTION_NOT_WITHDRAWABLE');

    const edit = await request(app)
      .patch(`/api/v1/auctions/${id}`)
      .set('Authorization', `Bearer ${seller.accessToken}`)
      .send({ title: 'Fixed typo' });
    expect(edit.status).toBe(200);
    expect((await submit(seller.accessToken, id)).body.auction.status).toBe('PENDING_REVIEW');
  });

  it('lets the seller cancel a pending listing', async () => {
    const seller = await createUser('seller');
    const id = await createDraft(seller.accessToken);
    await submit(seller.accessToken, id);
    const res = await request(app).post(`/api/v1/auctions/${id}/cancel`).set('Authorization', `Bearer ${seller.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.auction.status).toBe('CANCELLED');
  });

  it('refuses a suspended seller', async () => {
    const seller = await createUser('seller');
    const id = await createDraft(seller.accessToken);
    await prisma.user.update({ where: { id: seller.id }, data: { status: 'SUSPENDED' } });
    const res = await submit(seller.accessToken, id);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('admin decisions', () => {
  it('approval makes it live and starts the clock AT APPROVAL, not at submission', async () => {
    const admin = await createAdmin();
    const seller = await createUser('seller');
    const bidder = await createUser('bidder');
    const id = await createDraft(seller.accessToken);
    await submit(seller.accessToken, id, 90);
    await prisma.outboxEvent.deleteMany({ where: { key: id } });

    // The listing waits in the queue; the clock must not tick meanwhile.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const before = Date.now();
    const res = await moderate(admin.accessToken, id, { action: 'approve' });
    const after = Date.now();

    expect(res.status).toBe(200);
    expect(res.body.auction.status).toBe('ACTIVE');
    const startTime = new Date(res.body.auction.startTime).getTime();
    const endTime = new Date(res.body.auction.endTime).getTime();
    expect(startTime).toBeGreaterThanOrEqual(before - 5);
    expect(startTime).toBeLessThanOrEqual(after + 5);
    expect(endTime - startTime).toBe(90_000);
    expect(res.body.auction.reviewedAt).toEqual(expect.any(String));
    expect(res.body.auction.reviewNote).toBeNull();

    const audit = await prisma.adminAuditLog.findMany({ where: { targetId: id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: admin.id, action: 'auction.approve', metadata: { from: 'PENDING_REVIEW', to: 'ACTIVE' } });
    expect(await eventsFor(id, 'auction.reindex')).toHaveLength(1);
    expect((await eventsFor(id, 'auction.moderated'))[0]!.payload).toMatchObject({ action: 'approve', sellerId: seller.id });

    expect((await getAuction(id)).status).toBe(200);
    const bid = await request(app)
      .post(`/api/v1/auctions/${id}/bids`)
      .set('Authorization', `Bearer ${bidder.accessToken}`)
      .send({ amountCents: 2000, idempotencyKey: randomUUID() });
    expect(bid.status).toBe(201);
  });

  it('rejection needs a reason, returns the listing to DRAFT with the note, and resubmitting clears it', async () => {
    const admin = await createAdmin();
    const seller = await createUser('seller');
    const id = await createDraft(seller.accessToken);
    await submit(seller.accessToken, id);

    expect((await moderate(admin.accessToken, id, { action: 'reject' })).status).toBe(400);
    expect((await prisma.auction.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING_REVIEW');

    const res = await moderate(admin.accessToken, id, { action: 'reject', reason: 'Photos are too blurry to verify' });
    expect(res.status).toBe(200);
    expect(res.body.auction).toMatchObject({
      status: 'DRAFT',
      reviewNote: 'Photos are too blurry to verify',
      requestedDurationSeconds: null,
      submittedAt: null,
    });

    const seen = await getAuction(id, seller.accessToken);
    expect(seen.body.auction.reviewNote).toBe('Photos are too blurry to verify');
    expect((await getAuction(id)).status).toBe(404);
    expect((await prisma.adminAuditLog.findMany({ where: { targetId: id } }))[0]).toMatchObject({
      action: 'auction.reject',
      reason: 'Photos are too blurry to verify',
    });

    const resubmitted = await submit(seller.accessToken, id);
    expect(resubmitted.body.auction).toMatchObject({ status: 'PENDING_REVIEW', reviewNote: null });
  });

  it('refuses to approve or reject anything that is not pending, and only one of two simultaneous approvals wins', async () => {
    const adminA = await createAdmin();
    const adminB = await createAdmin();
    const seller = await createUser('seller');
    const draft = await createDraft(seller.accessToken);

    const notPending = await moderate(adminA.accessToken, draft, { action: 'approve' });
    expect(notPending.status).toBe(409);
    expect(notPending.body.error.code).toBe('AUCTION_NOT_REVIEWABLE');

    const id = await createDraft(seller.accessToken);
    await submit(seller.accessToken, id);
    const [a, b] = await Promise.all([
      moderate(adminA.accessToken, id, { action: 'approve' }),
      moderate(adminB.accessToken, id, { action: 'approve' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await prisma.adminAuditLog.count({ where: { targetId: id } })).toBe(1);
  });

  it('an approval racing the seller’s withdrawal has exactly one winner', async () => {
    const admin = await createAdmin();
    const seller = await createUser('seller');
    const id = await createDraft(seller.accessToken);
    await submit(seller.accessToken, id);

    const [approve, withdraw] = await Promise.all([
      moderate(admin.accessToken, id, { action: 'approve' }),
      request(app).post(`/api/v1/auctions/${id}/withdraw`).set('Authorization', `Bearer ${seller.accessToken}`),
    ]);
    expect([approve.status, withdraw.status].sort()).toEqual([200, 409]);
    const final = (await prisma.auction.findUniqueOrThrow({ where: { id } })).status;
    expect(final).toBe(approve.status === 200 ? 'ACTIVE' : 'DRAFT');
  });

  it('an admin can cancel a pending listing', async () => {
    const admin = await createAdmin();
    const seller = await createUser('seller');
    const id = await createDraft(seller.accessToken);
    await submit(seller.accessToken, id);
    const res = await moderate(admin.accessToken, id, { action: 'cancel', reason: 'Prohibited item' });
    expect(res.status).toBe(200);
    expect(res.body.auction.status).toBe('CANCELLED');
  });
});

describe('trusted sellers', () => {
  it('a trusted seller’s low-risk listing goes straight live; a high-risk one still waits and needs documents', async () => {
    const seller = await createUser('trusted', { trustedSeller: true });
    const lowRisk = await createDraft(seller.accessToken, 'OTHER');
    const live = await submit(seller.accessToken, lowRisk, 60);
    expect(live.status).toBe(200);
    expect(live.body.auction.status).toBe('ACTIVE');
    const length = new Date(live.body.auction.endTime).getTime() - new Date(live.body.auction.startTime).getTime();
    expect(length).toBe(60_000);

    const watch = await createDraft(seller.accessToken, 'WATCHES');
    const noDocs = await submit(seller.accessToken, watch);
    expect(noDocs.status).toBe(409);
    expect(noDocs.body.error.code).toBe('DOCUMENTS_REQUIRED');
    expect((await prisma.auction.findUniqueOrThrow({ where: { id: watch } })).status).toBe('DRAFT');
  });

  it('only an admin can change trust, it is audited, and repeating it records nothing', async () => {
    const admin = await createAdmin();
    const seller = await createUser('seller');
    const plain = await createUser('plain');

    expect(
      (await request(app).patch(`/api/v1/admin/users/${seller.id}/trusted`).set('Authorization', `Bearer ${plain.accessToken}`).send({ trusted: true })).status,
    ).toBe(403);

    const set = (trusted: boolean) =>
      request(app)
        .patch(`/api/v1/admin/users/${seller.id}/trusted`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ trusted, reason: 'Long-standing seller' });

    const granted = await set(true);
    expect(granted.status).toBe(200);
    expect(granted.body.user.trustedSeller).toBe(true);
    expect((await set(true)).status).toBe(200);

    const audit = await prisma.adminAuditLog.findMany({ where: { targetId: seller.id, action: 'user.trusted_changed' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: admin.id, metadata: { from: false, to: true } });

    expect((await set(false)).body.user.trustedSeller).toBe(false);
    const id = await createDraft(seller.accessToken);
    expect((await submit(seller.accessToken, id)).body.auction.status).toBe('PENDING_REVIEW');
  });
});
