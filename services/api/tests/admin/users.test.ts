import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { hashPassword } from '../../src/infrastructure/security/password';

const app = createApp();

const runId = Date.now();
let counter = 0;
const testEmails: string[] = [];
const createdAuctionIds: string[] = [];
const PASSWORD = 'correct-horse-battery';

function uniqueEmail(label: string): string {
  counter += 1;
  const email = `test-admin-${runId}-${counter}-${label}@example.com`.toLowerCase();
  testEmails.push(email);
  return email;
}

async function createAdmin() {
  const email = uniqueEmail('admin');
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(PASSWORD),
      name: 'Admin Test',
      role: 'ADMIN',
      emailVerifiedAt: new Date(),
    },
  });
  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { id: user.id, accessToken: loginRes.body.accessToken as string };
}

async function createUser(label = 'user') {
  const email = uniqueEmail(label);
  await request(app).post('/api/v1/auth/register').send({ email, password: PASSWORD, name: `Name ${label}` });
  const user = await prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { id: user.id, email, accessToken: loginRes.body.accessToken as string };
}

const setStatus = (token: string, userId: string, body: Record<string, unknown>) =>
  request(app).patch(`/api/v1/admin/users/${userId}/status`).set('Authorization', `Bearer ${token}`).send(body);

const getAs = (token: string, path: string) => request(app).get(path).set('Authorization', `Bearer ${token}`);

function auditFor(userId: string) {
  return prisma.adminAuditLog.findMany({
    where: { targetType: 'user', targetId: userId },
    orderBy: { createdAt: 'asc' },
  });
}

afterAll(async () => {
  const users = await prisma.user.findMany({ where: { email: { in: testEmails } }, select: { id: true } });
  await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: users.map((u) => u.id) } } });
  await prisma.bid.deleteMany({ where: { auctionId: { in: createdAuctionIds } } });
  await prisma.auction.deleteMany({ where: { id: { in: createdAuctionIds } } });
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  await prisma.$disconnect();
});

describe('admin access control', () => {
  it('rejects unauthenticated requests with 401', async () => {
    expect((await request(app).get('/api/v1/admin/users')).status).toBe(401);
    expect(
      (await request(app).patch('/api/v1/admin/users/whatever/status').send({ status: 'SUSPENDED', reason: 'x y z' })).status,
    ).toBe(401);
    expect((await request(app).get('/api/v1/admin/audit-log')).status).toBe(401);
  });

  it('rejects a non-admin with 403 on every admin endpoint', async () => {
    const { accessToken } = await createUser();

    const list = await getAs(accessToken, '/api/v1/admin/users');
    expect(list.status).toBe(403);
    expect(list.body.error.code).toBe('FORBIDDEN');

    const patch = await setStatus(accessToken, 'whatever', { status: 'SUSPENDED', reason: 'x y z' });
    expect(patch.status).toBe(403);

    expect((await getAs(accessToken, '/api/v1/admin/audit-log')).status).toBe(403);
  });
});

describe('GET /api/v1/admin/users', () => {
  it('never exposes password hashes, and filters by search, role and status', async () => {
    const admin = await createAdmin();
    const alice = await createUser('alicefindme');
    await createUser('bobother');
    await prisma.user.update({ where: { id: alice.id }, data: { status: 'SUSPENDED' } });

    const bySearch = await getAs(admin.accessToken, '/api/v1/admin/users?search=ALICEFINDME');
    expect(bySearch.status).toBe(200);
    expect(bySearch.body.users.map((u: { id: string }) => u.id)).toEqual([alice.id]);
    expect(JSON.stringify(bySearch.body)).not.toContain('passwordHash');
    expect(bySearch.body.users[0]).toHaveProperty('status', 'SUSPENDED');

    const byId = await getAs(admin.accessToken, `/api/v1/admin/users?search=${alice.id}`);
    expect(byId.body.users.map((u: { id: string }) => u.id)).toEqual([alice.id]);

    const suspended = await getAs(admin.accessToken, `/api/v1/admin/users?status=SUSPENDED&search=${runId}`);
    expect(suspended.body.users.map((u: { id: string }) => u.id)).toEqual([alice.id]);

    const admins = await getAs(admin.accessToken, `/api/v1/admin/users?role=ADMIN&search=${runId}`);
    expect(admins.body.users.map((u: { id: string }) => u.id)).toContain(admin.id);
    expect(admins.body.users.every((u: { role: string }) => u.role === 'ADMIN')).toBe(true);
  });

  it('paginates with a cursor without repeating or skipping users', async () => {
    const admin = await createAdmin();
    const created = await Promise.all([createUser('page'), createUser('page'), createUser('page')]);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/api/v1/admin/users?search=${runId}-&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await getAs(admin.accessToken, url);
      expect(res.status).toBe(200);
      seen.push(...res.body.users.map((u: { id: string }) => u.id));
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);

    expect(new Set(seen).size).toBe(seen.length);
    for (const u of created) expect(seen).toContain(u.id);
    expect(pages).toBeGreaterThan(1);
  });

  it('rejects a malformed cursor and an out-of-range limit', async () => {
    const admin = await createAdmin();
    expect((await getAs(admin.accessToken, '/api/v1/admin/users?cursor=not-a-cursor')).status).toBe(400);
    expect((await getAs(admin.accessToken, '/api/v1/admin/users?limit=1000')).status).toBe(400);
  });
});

describe('PATCH /api/v1/admin/users/:userId/status', () => {
  it('suspends a user, records who and why in the audit log, and the suspension blocks login', async () => {
    const admin = await createAdmin();
    const target = await createUser('target');

    const res = await setStatus(admin.accessToken, target.id, { status: 'SUSPENDED', reason: 'Spamming bids' });
    expect(res.status).toBe(200);
    expect(res.body.user.status).toBe('SUSPENDED');
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');

    const audit = await auditFor(target.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: admin.id,
      action: 'user.status_changed',
      targetType: 'user',
      reason: 'Spamming bids',
      metadata: { from: 'ACTIVE', to: 'SUSPENDED' },
    });

    const login = await request(app).post('/api/v1/auth/login').send({ email: target.email, password: PASSWORD });
    expect(login.status).toBe(401);
    expect(login.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('reinstates a user without needing a reason, and they can log in again', async () => {
    const admin = await createAdmin();
    const target = await createUser('reinstate');
    await setStatus(admin.accessToken, target.id, { status: 'BANNED', reason: 'Fraud' });

    const res = await setStatus(admin.accessToken, target.id, { status: 'ACTIVE' });
    expect(res.status).toBe(200);
    expect(res.body.user.status).toBe('ACTIVE');
    const login = await request(app).post('/api/v1/auth/login').send({ email: target.email, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(await auditFor(target.id)).toHaveLength(2);
  });

  it('requires a reason to suspend or ban, and changes nothing without one', async () => {
    const admin = await createAdmin();
    const target = await createUser('noreason');

    const res = await setStatus(admin.accessToken, target.id, { status: 'BANNED' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).status).toBe('ACTIVE');
    expect(await auditFor(target.id)).toHaveLength(0);
  });

  it('is a no-op success with no audit entry when the status is already set', async () => {
    const admin = await createAdmin();
    const target = await createUser('noop');

    const res = await setStatus(admin.accessToken, target.id, { status: 'ACTIVE' });
    expect(res.status).toBe(200);
    expect(await auditFor(target.id)).toHaveLength(0);
  });

  it('records exactly one entry when two admins make the same change at once', async () => {
    const adminA = await createAdmin();
    const adminB = await createAdmin();
    const target = await createUser('race');

    const [a, b] = await Promise.all([
      setStatus(adminA.accessToken, target.id, { status: 'SUSPENDED', reason: 'Race test' }),
      setStatus(adminB.accessToken, target.id, { status: 'SUSPENDED', reason: 'Race test' }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await auditFor(target.id)).toHaveLength(1);
  });

  it('refuses an admin moderating themselves or another admin', async () => {
    const admin = await createAdmin();
    const otherAdmin = await createAdmin();

    const self = await setStatus(admin.accessToken, admin.id, { status: 'SUSPENDED', reason: 'Oops' });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('CANNOT_MODERATE_SELF');

    const other = await setStatus(admin.accessToken, otherAdmin.id, { status: 'SUSPENDED', reason: 'Takeover' });
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe('CANNOT_MODERATE_ADMIN');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: otherAdmin.id } })).status).toBe('ACTIVE');
  });

  it('returns 404 for a nonexistent user and 400 for an invalid status', async () => {
    const admin = await createAdmin();
    const missing = await setStatus(admin.accessToken, randomUUID(), { status: 'SUSPENDED', reason: 'Nobody' });
    expect(missing.status).toBe(404);

    const invalid = await setStatus(admin.accessToken, randomUUID(), { status: 'NOT_A_REAL_STATUS' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('a banned user still holding a valid access token', () => {
  it('can no longer place bids or create auctions (a stateless JWT must not outlive a ban)', async () => {
    const admin = await createAdmin();
    const seller = await createUser('seller');
    const banned = await createUser('banned');

    const created = await request(app)
      .post('/api/v1/auctions')
      .set('Authorization', `Bearer ${seller.accessToken}`)
      .send({ title: 'Ban Test Lot', description: 'desc', category: 'OTHER', condition: 'GOOD', startingPriceCents: 1000 });
    const auctionId = created.body.auction.id as string;
    createdAuctionIds.push(auctionId);
    await request(app)
      .post(`/api/v1/auctions/${auctionId}/publish`)
      .set('Authorization', `Bearer ${seller.accessToken}`)
      .send({ endTime: new Date(Date.now() + 3_600_000).toISOString() });
    await request(app).post(`/api/v1/auctions/${auctionId}/start`).set('Authorization', `Bearer ${seller.accessToken}`);

    await setStatus(admin.accessToken, banned.id, { status: 'BANNED', reason: 'Fraud' });

    const bid = await request(app)
      .post(`/api/v1/auctions/${auctionId}/bids`)
      .set('Authorization', `Bearer ${banned.accessToken}`)
      .send({ amountCents: 2000, idempotencyKey: randomUUID() });
    expect(bid.status).toBe(403);
    expect(bid.body.error.code).toBe('ACCOUNT_DISABLED');
    expect(await prisma.bid.count({ where: { auctionId } })).toBe(0);

    const create = await request(app)
      .post('/api/v1/auctions')
      .set('Authorization', `Bearer ${banned.accessToken}`)
      .send({ title: 'Banned Seller Lot', description: 'desc', category: 'OTHER', condition: 'GOOD', startingPriceCents: 1000 });
    expect(create.status).toBe(403);
    expect(create.body.error.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('GET /api/v1/admin/audit-log', () => {
  it('lists entries newest first and filters by target', async () => {
    const admin = await createAdmin();
    const target = await createUser('audited');
    await setStatus(admin.accessToken, target.id, { status: 'SUSPENDED', reason: 'First' });
    await setStatus(admin.accessToken, target.id, { status: 'ACTIVE' });

    const res = await getAs(admin.accessToken, `/api/v1/admin/audit-log?targetType=user&targetId=${target.id}`);
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: { metadata: { to: string } }) => e.metadata.to)).toEqual(['ACTIVE', 'SUSPENDED']);
    expect(res.body.entries[1].reason).toBe('First');
  });
});
