import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { runOnce as runClosingWorkerOnce } from '../../src/infrastructure/jobs/auctionClosingWorker';
import { hashPassword } from '../../src/infrastructure/security/password';
import { handleNotificationEvent } from '../../src/modules/notifications/consumer';

const app = createApp();

const runId = Date.now();
let counter = 0;
const testEmails: string[] = [];
const createdAuctionIds: string[] = [];
const PASSWORD = 'correct-horse-battery';

function uniqueEmail(label: string): string {
  counter += 1;
  const email = `test-mod-${runId}-${counter}-${label}@example.com`.toLowerCase();
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

async function createUser(label: string) {
  const email = uniqueEmail(label);
  await request(app).post('/api/v1/auth/register').send({ email, password: PASSWORD, name: label });
  const user = await prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { id: user.id, accessToken: login.body.accessToken as string };
}

async function createAuction(sellerToken: string, opts: { start: boolean; endInMs?: number } = { start: true }) {
  const created = await request(app)
    .post('/api/v1/auctions')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ title: 'Moderation Lot', description: 'desc', category: 'OTHER', condition: 'GOOD', startingPriceCents: 1000 });
  const id = created.body.auction.id as string;
  createdAuctionIds.push(id);
  if (opts.start) {
    await request(app)
      .post(`/api/v1/auctions/${id}/publish`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ endTime: new Date(Date.now() + (opts.endInMs ?? 3_600_000)).toISOString() });
    await request(app).post(`/api/v1/auctions/${id}/start`).set('Authorization', `Bearer ${sellerToken}`);
  }
  return id;
}

const moderate = (token: string, auctionId: string, body: Record<string, unknown>) =>
  request(app).post(`/api/v1/admin/auctions/${auctionId}/moderate`).set('Authorization', `Bearer ${token}`).send(body);

const getAs = (token: string, path: string) => request(app).get(path).set('Authorization', `Bearer ${token}`);

async function eventsFor(key: string, type: string) {
  const rows = await prisma.outboxEvent.findMany({ where: { key } });
  return rows.filter((r) => (r.payload as { type: string }).type === type);
}

afterAll(async () => {
  const orders = await prisma.order.findMany({ where: { auctionId: { in: createdAuctionIds } }, select: { id: true } });
  const keys = [...createdAuctionIds, ...orders.map((o) => o.id)];
  await prisma.outboxEvent.deleteMany({ where: { key: { in: keys } } });
  await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: createdAuctionIds } } });
  await prisma.notification.deleteMany({ where: { auctionId: { in: createdAuctionIds } } });
  await prisma.payment.deleteMany({ where: { orderId: { in: orders.map((o) => o.id) } } });
  await prisma.order.deleteMany({ where: { auctionId: { in: createdAuctionIds } } });
  await prisma.bid.deleteMany({ where: { auctionId: { in: createdAuctionIds } } });
  await prisma.auction.deleteMany({ where: { id: { in: createdAuctionIds } } });
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  await prisma.$disconnect();
});

describe('admin access control (auctions, orders, stats)', () => {
  it('rejects anonymous with 401 and a normal user with 403', async () => {
    const user = await createUser('plain');
    for (const path of ['/api/v1/admin/stats', '/api/v1/admin/auctions', '/api/v1/admin/orders']) {
      expect((await request(app).get(path)).status).toBe(401);
      expect((await getAs(user.accessToken, path)).status).toBe(403);
    }
    expect((await moderate(user.accessToken, randomUUID(), { action: 'cancel', reason: 'nope' })).status).toBe(403);
  });
});

describe('POST /api/v1/admin/auctions/:id/moderate', () => {
  it('pauses an ACTIVE auction of any seller, with audit entry, reindex + seller events', async () => {
    const admin = await createAdmin();
    const seller = await createUser('seller');
    const auctionId = await createAuction(seller.accessToken);
    await prisma.outboxEvent.deleteMany({ where: { key: auctionId } });

    const res = await moderate(admin.accessToken, auctionId, { action: 'pause', reason: 'Suspicious listing' });
    expect(res.status).toBe(200);
    expect(res.body.auction.status).toBe('PAUSED');

    const audit = await prisma.adminAuditLog.findMany({ where: { targetType: 'auction', targetId: auctionId } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: admin.id,
      action: 'auction.pause',
      reason: 'Suspicious listing',
      metadata: { from: 'ACTIVE', to: 'PAUSED' },
    });
    expect(await eventsFor(auctionId, 'auction.reindex')).toHaveLength(1);
    const moderated = await eventsFor(auctionId, 'auction.moderated');
    expect(moderated).toHaveLength(1);
    expect(moderated[0]!.payload).toMatchObject({ sellerId: seller.id, action: 'pause', reason: 'Suspicious listing' });
  });

  it('a seller cannot lift a moderator’s pause, but can still resume their own pause', async () => {
    const admin = await createAdmin();
    const seller = await createUser('seller');
    const auctionId = await createAuction(seller.accessToken);
    const sellerStart = () =>
      request(app).post(`/api/v1/auctions/${auctionId}/start`).set('Authorization', `Bearer ${seller.accessToken}`);

    await moderate(admin.accessToken, auctionId, { action: 'pause', reason: 'Under investigation' });
    const blocked = await sellerStart();
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('AUCTION_HELD_BY_ADMIN');
    expect((await prisma.auction.findUniqueOrThrow({ where: { id: auctionId } })).status).toBe('PAUSED');

    await moderate(admin.accessToken, auctionId, { action: 'resume' });
    expect((await prisma.auction.findUniqueOrThrow({ where: { id: auctionId } })).heldByAdmin).toBe(false);

    // The seller's OWN pause is theirs to resume.
    await request(app).post(`/api/v1/auctions/${auctionId}/pause`).set('Authorization', `Bearer ${seller.accessToken}`);
    expect((await sellerStart()).status).toBe(200);
  });

  it('a paused auction rejects bids, and resume brings it back (no reason needed)', async () => {
    const admin = await createAdmin();
    const seller = await createUser('seller');
    const bidder = await createUser('bidder');
    const auctionId = await createAuction(seller.accessToken);
    await moderate(admin.accessToken, auctionId, { action: 'pause', reason: 'Checking' });

    const bid = (amountCents: number) =>
      request(app)
        .post(`/api/v1/auctions/${auctionId}/bids`)
        .set('Authorization', `Bearer ${bidder.accessToken}`)
        .send({ amountCents, idempotencyKey: randomUUID() });
    const blocked = await bid(2000);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('AUCTION_NOT_ACTIVE');

    const resumed = await moderate(admin.accessToken, auctionId, { action: 'resume' });
    expect(resumed.status).toBe(200);
    expect(resumed.body.auction.status).toBe('ACTIVE');
    expect((await bid(2000)).status).toBe(201);
  });

  it('cancels an auction, sets endedAt, and requires a reason', async () => {
    const admin = await createAdmin();
    const seller = await createUser('seller');
    const auctionId = await createAuction(seller.accessToken);

    const noReason = await moderate(admin.accessToken, auctionId, { action: 'cancel' });
    expect(noReason.status).toBe(400);
    expect((await prisma.auction.findUniqueOrThrow({ where: { id: auctionId } })).status).toBe('ACTIVE');

    const res = await moderate(admin.accessToken, auctionId, { action: 'cancel', reason: 'Prohibited item' });
    expect(res.status).toBe(200);
    expect(res.body.auction.status).toBe('CANCELLED');
    expect(res.body.auction.endedAt).toEqual(expect.any(String));
  });

  it('cannot touch a DRAFT at all, and refuses repeat cancels with a 409', async () => {
    const admin = await createAdmin();
    const seller = await createUser('seller');
    const draft = await createAuction(seller.accessToken, { start: false });

    const pauseDraft = await moderate(admin.accessToken, draft, { action: 'pause', reason: 'Not live' });
    expect(pauseDraft.status).toBe(409);
    expect(pauseDraft.body.error.code).toBe('AUCTION_NOT_PAUSABLE');
    const resumeDraft = await moderate(admin.accessToken, draft, { action: 'resume' });
    expect(resumeDraft.status).toBe(409);

    const cancelDraft = await moderate(admin.accessToken, draft, { action: 'cancel', reason: 'Abandoned' });
    expect(cancelDraft.status).toBe(409);
    expect(cancelDraft.body.error.code).toBe('AUCTION_NOT_CANCELLABLE');

    const live = await createAuction(seller.accessToken);
    expect((await moderate(admin.accessToken, live, { action: 'cancel', reason: 'Abandoned' })).status).toBe(200);
    const again = await moderate(admin.accessToken, live, { action: 'cancel', reason: 'Again' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('AUCTION_NOT_CANCELLABLE');
    expect(await prisma.adminAuditLog.count({ where: { targetId: { in: [draft, live] } } })).toBe(1);
  });

  it('refuses to cancel an ENDED auction that already has an order', async () => {
    const admin = await createAdmin();
    const seller = await createUser('seller');
    const buyer = await createUser('buyer');
    const auctionId = await createAuction(seller.accessToken);
    await request(app)
      .post(`/api/v1/auctions/${auctionId}/bids`)
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ amountCents: 2000, idempotencyKey: randomUUID() });
    await prisma.auction.update({ where: { id: auctionId }, data: { endTime: new Date(Date.now() - 1_000) } });
    await runClosingWorkerOnce();

    const res = await moderate(admin.accessToken, auctionId, { action: 'cancel', reason: 'Too late' });
    expect(res.status).toBe(409);
    expect((await prisma.auction.findUniqueOrThrow({ where: { id: auctionId } })).status).toBe('ENDED');
    expect(await prisma.order.count({ where: { auctionId } })).toBe(1);
  });

  it('will not resume an auction whose end time has already passed', async () => {
    const admin = await createAdmin();
    const seller = await createUser('seller');
    const auctionId = await createAuction(seller.accessToken);
    await moderate(admin.accessToken, auctionId, { action: 'pause', reason: 'Hold' });
    await prisma.auction.update({ where: { id: auctionId }, data: { endTime: new Date(Date.now() - 1_000) } });

    const res = await moderate(admin.accessToken, auctionId, { action: 'resume' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AUCTION_SCHEDULE_EXPIRED');
    expect((await prisma.auction.findUniqueOrThrow({ where: { id: auctionId } })).status).toBe('PAUSED');
  });

  it('two concurrent cancels produce one change and one audit entry', async () => {
    const adminA = await createAdmin();
    const adminB = await createAdmin();
    const seller = await createUser('seller');
    const auctionId = await createAuction(seller.accessToken);

    const [a, b] = await Promise.all([
      moderate(adminA.accessToken, auctionId, { action: 'cancel', reason: 'Race A' }),
      moderate(adminB.accessToken, auctionId, { action: 'cancel', reason: 'Race B' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await prisma.adminAuditLog.count({ where: { targetId: auctionId } })).toBe(1);
    expect(await eventsFor(auctionId, 'auction.moderated')).toHaveLength(1);
  });

  it('returns 404 for a missing auction and 400 for an unknown action', async () => {
    const admin = await createAdmin();
    expect((await moderate(admin.accessToken, randomUUID(), { action: 'cancel', reason: 'Ghost' })).status).toBe(404);
    expect((await moderate(admin.accessToken, randomUUID(), { action: 'delete', reason: 'Nope' })).status).toBe(400);
  });

  it('turns the event into a seller notification carrying the reason', async () => {
    const seller = await createUser('notified');
    const auctionId = randomUUID();
    await handleNotificationEvent(
      'auction-events',
      auctionId,
      { type: 'auction.moderated', auctionId, sellerId: seller.id, action: 'cancel', reason: 'Prohibited item' },
      `moderated-${randomUUID()}`,
    );
    const rows = await prisma.notification.findMany({ where: { userId: seller.id, type: 'AUCTION_MODERATED' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toEqual({ action: 'cancel', reason: 'Prohibited item' });
    await prisma.notification.deleteMany({ where: { userId: seller.id } });
  });
});

describe('GET /api/v1/admin/auctions', () => {
  it('lists submitted and live auctions with seller info and bid count, but never drafts', async () => {
    const admin = await createAdmin();
    const seller = await createUser('lister');
    const draft = await createAuction(seller.accessToken, { start: false });
    const live = await createAuction(seller.accessToken);

    const all = await getAs(admin.accessToken, '/api/v1/admin/auctions?limit=100');
    expect(all.status).toBe(200);
    const ids = all.body.auctions.map((a: { id: string }) => a.id);
    expect(ids).toContain(live);
    expect(ids).not.toContain(draft);
    const liveRow = all.body.auctions.find((a: { id: string }) => a.id === live);
    expect(liveRow).toMatchObject({ sellerEmail: expect.stringContaining('lister'), bidCount: 0, status: 'ACTIVE' });

    const drafts = await getAs(admin.accessToken, '/api/v1/admin/auctions?status=DRAFT&search=Moderation&limit=100');
    expect(drafts.body.auctions.map((a: { id: string }) => a.id)).not.toContain(draft);
    expect(drafts.body.auctions.every((a: { status: string }) => a.status !== 'DRAFT')).toBe(true);
  });
});

describe('GET /api/v1/admin/orders and /stats', () => {
  it('flags a paid-but-cancelled order as needing a refund, and counts it in stats', async () => {
    const admin = await createAdmin();
    const seller = await createUser('seller');
    const buyer = await createUser('buyer');
    const auctionId = await createAuction(seller.accessToken);
    await request(app)
      .post(`/api/v1/auctions/${auctionId}/bids`)
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ amountCents: 3000, idempotencyKey: randomUUID() });
    await prisma.auction.update({ where: { id: auctionId }, data: { endTime: new Date(Date.now() - 1_000) } });
    await runClosingWorkerOnce();
    const order = await prisma.order.findUniqueOrThrow({ where: { auctionId } });
    await prisma.payment.create({
      data: { orderId: order.id, provider: 'test', providerRef: `r-${order.id}`, amountCents: 3000, idempotencyKey: 'k', status: 'SUCCEEDED' },
    });
    await prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED', cancelReason: 'PAYMENT_TIMEOUT' } });

    const refund = await getAs(admin.accessToken, '/api/v1/admin/orders?needsRefund=true&limit=100');
    expect(refund.status).toBe(200);
    const row = refund.body.orders.find((o: { id: string }) => o.id === order.id);
    expect(row).toMatchObject({ needsRefund: true, status: 'CANCELLED', buyerEmail: expect.stringContaining('buyer') });

    const all = await getAs(admin.accessToken, '/api/v1/admin/orders?limit=100');
    expect(all.body.orders.find((o: { id: string }) => o.id === order.id)?.needsRefund).toBe(true);

    const stats = await getAs(admin.accessToken, '/api/v1/admin/stats');
    expect(stats.status).toBe(200);
    expect(stats.body.stats.needsRefund).toBeGreaterThanOrEqual(1);
    expect(stats.body.stats.users.total).toBeGreaterThanOrEqual(3);
    expect(stats.body.stats.auctions.ENDED).toBeGreaterThanOrEqual(1);
    expect(stats.body.stats.bids.total).toBeGreaterThanOrEqual(1);
    expect(stats.body.stats.revenueCents).toEqual(expect.any(Number));
  });

  it('rejects an invalid order status filter', async () => {
    const admin = await createAdmin();
    expect((await getAs(admin.accessToken, '/api/v1/admin/orders?status=BOGUS')).status).toBe(400);
  });
});
