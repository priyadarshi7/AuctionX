import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { hashPassword } from '../../src/infrastructure/security/password';

const app = createApp();

const runId = Date.now();
const testEmails: string[] = [];

function uniqueEmail(label: string): string {
  const email = `test-login-${runId}-${label}@example.com`.toLowerCase();
  testEmails.push(email);
  return email;
}

async function registerTestUser(email: string, password: string, name = 'Login Test') {
  const res = await request(app).post('/api/v1/auth/register').send({ email, password, name });
  expect(res.status).toBe(201);
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  await prisma.$disconnect();
});

describe('POST /api/v1/auth/login', () => {
  it('logs in with correct credentials: returns access token and sets refresh cookie', async () => {
    const email = uniqueEmail('success');
    const password = 'correct-horse-battery';
    await registerTestUser(email, password);

    const res = await request(app).post('/api/v1/auth/login').send({ email, password });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.expiresIn).toEqual(expect.any(Number));
    expect(res.body.user.email).toBe(email);
    expect(res.body.user.passwordHash).toBeUndefined();

    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookieHeader = (Array.isArray(setCookie) ? setCookie : [setCookie]).join(';');
    expect(cookieHeader).toMatch(/refreshToken=/);
    expect(cookieHeader).toMatch(/HttpOnly/i);
    expect(cookieHeader).toMatch(/Path=\/api\/v1\/auth/i);
  });

  it('rejects a wrong password and a nonexistent email identically', async () => {
    const email = uniqueEmail('wrongpass');
    await registerTestUser(email, 'correct-horse-battery');

    const wrongPassword = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'totally-wrong' });
    const noSuchUser = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: uniqueEmail('nosuchuser'), password: 'whatever123' });

    expect(wrongPassword.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    // Same code and message for both — neither response should let a caller
    // distinguish "wrong password" from "no such account".
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(noSuchUser.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(wrongPassword.body.error.message).toBe(noSuchUser.body.error.message);
  });

  it('rejects login for a non-active account', async () => {
    const email = uniqueEmail('suspended');
    const password = 'correct-horse-battery';
    testEmails.push(email);
    await prisma.user.create({
      data: {
        email,
        passwordHash: await hashPassword(password),
        name: 'Suspended Test',
        status: 'SUSPENDED',
      },
    });

    const res = await request(app).post('/api/v1/auth/login').send({ email, password });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('rejects an invalid payload with a structured 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email', password: '' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/v1/auth/me', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a garbage bearer token', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it('returns the current user for a valid access token', async () => {
    const email = uniqueEmail('me');
    const password = 'correct-horse-battery';
    await registerTestUser(email, password);

    const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
    const accessToken = loginRes.body.accessToken as string;

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('revokes the refresh token and clears the cookie', async () => {
    const email = uniqueEmail('logout');
    const password = 'correct-horse-battery';
    await registerTestUser(email, password);

    const agent = request.agent(app);
    const loginRes = await agent.post('/api/v1/auth/login').send({ email, password });
    expect(loginRes.status).toBe(200);

    const tokenRow = await prisma.refreshToken.findFirst({
      where: { user: { email } },
      orderBy: { createdAt: 'desc' },
    });
    expect(tokenRow?.revokedAt).toBeNull();

    const logoutRes = await agent.post('/api/v1/auth/logout');
    expect(logoutRes.status).toBe(204);

    const revoked = await prisma.refreshToken.findUniqueOrThrow({
      where: { id: tokenRow!.id },
    });
    expect(revoked.revokedAt).not.toBeNull();

    // Idempotent: logging out again (cookie already cleared client-side, but
    // even resending no cookie at all) must not error.
    const secondLogout = await request(app).post('/api/v1/auth/logout');
    expect(secondLogout.status).toBe(204);
  });
});
