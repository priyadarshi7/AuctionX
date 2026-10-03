import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { hashPassword } from '../../src/infrastructure/security/password';
import { clearUserBlocked } from '../../src/infrastructure/security/blockedUsers';
import { handleNotificationEvent } from '../../src/modules/notifications/consumer';
import { cancelAuctionRow, pauseAuctionRow, startAuctionRow } from '../../src/modules/auctions/repository';

const app = createApp();

const runId = Date.now();
let counter = 0;
const testEmails: string[] = [];
const userIds: string[] = [];
const createdAuctionIds: string[] = [];
const PASSWORD = 'correct-horse-battery';

function uniqueEmail(label: string): string {
  counter += 1;
  const email = `test-hard-${runId}-${counter}-${label}@example.com`.toLowerCase();
  testEmails.push(email);
  return email;
}

async function createAdmin() {
  const email = uniqueEmail('admin');
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashPassword(PASSWORD), name: 'Admin', role: 'ADMIN', emailVerifiedAt: new Date() },
  });
  userIds.push(user.id);
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { id: user.id, accessToken: login.body.accessToken as string };
}

async function createUser(label: string) {
  const email = uniqueEmail(label);
  await request(app).post('/api/v1/auth/register').send({ email, password: PASSWORD, name: label });
  const user = await prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
  userIds.push(user.id);
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { id: user.id, accessToken: login.body.accessToken as string };
}

async function createLiveAuction(sellerToken: string) {
  const created = await request(app)
    .post('/api/v1/auctions')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ title: 'Hardening Lot', description: 'desc', category: 'OTHER', condition: 'GOOD', startingPriceCents: 1000 });
  const id = created.body.auction.id as string;
  createdAuctionIds.push(id);
  await request(app)
    .post(`/api/v1/auctions/${id}/publish`)
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ endTime: new Date(Date.now() + 3_600_000).toISOString() });
  await request(app).post(`/api/v1/auctions/${id}/start`).set('Authorization', `Bearer ${sellerToken}`);
  return id;
}

const as = (token: string) => ({ Authorization: `Bearer ${token}` });

afterAll(async () => {
  await prisma.outboxEvent.deleteMany({ where: { key: { in: createdAuctionIds } } });
  await prisma.adminAuditLog.deleteMany({ where: { OR: [{ targetId: { in: createdAuctionIds } }, { targetId: { in: userIds } }] } });
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.bid.deleteMany({ where: { auctionId: { in: createdAuctionIds } } });
  await prisma.auction.deleteMany({ where: { id: { in: createdAuctionIds } } });
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  await Promise.all(userIds.map((id) => clearUserBlocked(id)));
  await prisma.$disconnect();
});

describe('restricted accounts lose access immediately, not when the token expires', () => {
  it('rejects a banned user’s still-valid access token, and restores it on reactivation', async () => {
    const admin = await createAdmin();
    const user = await createUser('victim');

    const before = await request(app).get('/api/v1/notifications').set(as(user.accessToken));
    expect(before.status).toBe(200);

    const ban = await request(app)
      .patch(`/api/v1/admin/users/${user.id}/status`)
      .set(as(admin.accessToken))
      .send({ status: 'BANNED', reason: 'Fraudulent listings' });
    expect(ban.status).toBe(200);

    const blocked = await request(app).get('/api/v1/notifications').set(as(user.accessToken));
    expect(blocked.status).toBe(401);
    expect(blocked.body.error.code).toBe('ACCOUNT_DISABLED');

    const restore = await request(app)
      .patch(`/api/v1/admin/users/${user.id}/status`)
      .set(as(admin.accessToken))
      .send({ status: 'ACTIVE', reason: 'Appeal accepted' });
    expect(restore.status).toBe(200);
    expect((await request(app).get('/api/v1/notifications').set(as(user.accessToken))).status).toBe(200);
  });
});

describe('seller lifecycle actions are guarded against state changes in between', () => {
  it('pause, start and cancel match nothing once the auction has ENDED (no overwrite of a closed auction)', async () => {
    const seller = await createUser('seller');
    const id = await createLiveAuction(seller.accessToken);
    await prisma.auction.update({ where: { id }, data: { status: 'ENDED', endedAt: new Date() } });

    expect(await pauseAuctionRow(id)).toBeNull();
    expect(await startAuctionRow(id)).toBeNull();
    expect(await cancelAuctionRow(id)).toBeNull();
    expect((await prisma.auction.findUniqueOrThrow({ where: { id } })).status).toBe('ENDED');

    const res = await request(app).post(`/api/v1/auctions/${id}/cancel`).set(as(seller.accessToken));
    expect(res.status).toBe(409);
  });

  it('only one of two simultaneous cancels wins', async () => {
    const seller = await createUser('seller');
    const id = await createLiveAuction(seller.accessToken);
    const results = await Promise.all([cancelAuctionRow(id), cancelAuctionRow(id)]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });
});

describe('an admin cancellation tells every bidder', () => {
  it('notifies each distinct bidder once, even if the event is redelivered, and not the seller twice', async () => {
    const seller = await createUser('seller');
    const bidderA = await createUser('bidderA');
    const bidderB = await createUser('bidderB');
    const id = await createLiveAuction(seller.accessToken);
    for (const [bidder, amount] of [
      [bidderA, 2000],
      [bidderB, 3000],
      [bidderA, 4000],
    ] as const) {
      const res = await request(app)
        .post(`/api/v1/auctions/${id}/bids`)
        .set(as(bidder.accessToken))
        .send({ amountCents: amount, idempotencyKey: randomUUID() });
      expect(res.status).toBe(201);
    }

    const event = { type: 'auction.moderated', auctionId: id, sellerId: seller.id, action: 'cancel', reason: 'Prohibited item' };
    const messageId = `moderated-${randomUUID()}`;
    await handleNotificationEvent('auction-events', id, event, messageId);
    await handleNotificationEvent('auction-events', id, event, messageId);

    const count = (userId: string) => prisma.notification.count({ where: { userId, auctionId: id, type: 'AUCTION_MODERATED' } });
    expect(await count(bidderA.id)).toBe(1);
    expect(await count(bidderB.id)).toBe(1);
    expect(await count(seller.id)).toBe(1);
    const row = await prisma.notification.findFirstOrThrow({ where: { userId: bidderA.id, auctionId: id } });
    expect(row.data).toMatchObject({ action: 'cancel', asBidder: true, reason: 'Prohibited item' });
  });
});
