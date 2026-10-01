import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { hashPassword } from '../../src/infrastructure/security/password';

const app = createApp();

const runId = Date.now();
let counter = 0;
const testEmails: string[] = [];

// Includes a call counter, not just the label: this file calls createAdmin()
// from multiple tests, and a label-only key would collide on the second
// call within the same run (that's exactly what broke here initially).
function uniqueEmail(label: string): string {
  counter += 1;
  const email = `test-rbac-${runId}-${counter}-${label}@example.com`.toLowerCase();
  testEmails.push(email);
  return email;
}

async function createAdmin() {
  const email = uniqueEmail('admin');
  const password = 'correct-horse-battery';
  await prisma.user.create({
    data: { email, passwordHash: await hashPassword(password), name: 'Admin Test', role: 'ADMIN' },
  });
  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
  return loginRes.body.accessToken as string;
}

async function registerAndLoginRegularUser() {
  const email = uniqueEmail('user');
  const password = 'correct-horse-battery';
  await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password, name: 'Regular User' });
  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
  return { email, accessToken: loginRes.body.accessToken as string };
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  await prisma.$disconnect();
});

describe('PATCH /api/v1/auth/users/:userId/status', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(app)
      .patch('/api/v1/auth/users/whatever/status')
      .send({ status: 'SUSPENDED' });
    expect(res.status).toBe(401);
  });

  it('rejects a non-admin user with 403', async () => {
    const { accessToken } = await registerAndLoginRegularUser();

    const res = await request(app)
      .patch('/api/v1/auth/users/whatever/status')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ status: 'SUSPENDED' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('allows an admin to suspend a user, and the suspension actually blocks login', async () => {
    const adminToken = await createAdmin();
    const { email, accessToken: targetInitialToken } = await registerAndLoginRegularUser();
    void targetInitialToken;

    const target = await prisma.user.findUniqueOrThrow({ where: { email } });

    const res = await request(app)
      .patch(`/api/v1/auth/users/${target.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'SUSPENDED' });

    expect(res.status).toBe(200);
    expect(res.body.user.status).toBe('SUSPENDED');

    // Prove this had a real effect elsewhere in the system, not just a DB
    // field flip: the suspended user can no longer log in.
    const loginAttempt = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'correct-horse-battery' });
    expect(loginAttempt.status).toBe(401);
    expect(loginAttempt.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('returns 404 for a nonexistent target user', async () => {
    const adminToken = await createAdmin();

    const res = await request(app)
      .patch('/api/v1/auth/users/00000000-0000-0000-0000-000000000000/status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'SUSPENDED' });

    expect(res.status).toBe(404);
  });

  it('rejects an invalid status value', async () => {
    const adminToken = await createAdmin();

    const res = await request(app)
      .patch('/api/v1/auth/users/00000000-0000-0000-0000-000000000000/status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'NOT_A_REAL_STATUS' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
