import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { fakeEmailSender } from '../../src/infrastructure/email/sender';
import { hashPassword } from '../../src/infrastructure/security/password';

const app = createApp();

const runId = Date.now();
let counter = 0;
const testEmails: string[] = [];

function uniqueEmail(label: string): string {
  counter += 1;
  const email = `test-pwreset-${runId}-${counter}-${label}@example.com`;
  testEmails.push(email);
  return email;
}

function extractTokenFromLink(html: string): string {
  const match = /token=([^"&\s<]+)/.exec(html);
  if (!match) throw new Error(`No token found in email HTML: ${html}`);
  return match[1] as string;
}

beforeEach(() => {
  fakeEmailSender.reset();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
});

describe('POST /api/v1/auth/forgot-password', () => {
  it('returns the same generic response whether or not the email exists', async () => {
    const email = uniqueEmail('exists');
    await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'correct-horse-battery', name: 'Exists Test' });

    const existing = await request(app).post('/api/v1/auth/forgot-password').send({ email });
    const nonexistent = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: uniqueEmail('missing') });

    expect(existing.status).toBe(200);
    expect(nonexistent.status).toBe(200);
    expect(existing.body).toEqual(nonexistent.body);
  });

  it('only actually sends an email when the account exists', async () => {
    const email = uniqueEmail('sends');
    await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'correct-horse-battery', name: 'Sends Test' });

    await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: uniqueEmail('nosend') });
    expect(fakeEmailSender.sent).toHaveLength(0);

    await request(app).post('/api/v1/auth/forgot-password').send({ email });
    expect(fakeEmailSender.sent).toHaveLength(1);
    expect(fakeEmailSender.sent[0]?.to).toBe(email);
    expect(fakeEmailSender.sent[0]?.html).toContain('token=');
  });

  it('invalidates a previous outstanding token when a new one is requested', async () => {
    const email = uniqueEmail('reissue');
    await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'correct-horse-battery', name: 'Reissue Test' });

    await request(app).post('/api/v1/auth/forgot-password').send({ email });
    const firstToken = extractTokenFromLink(fakeEmailSender.sent[0]!.html);

    await request(app).post('/api/v1/auth/forgot-password').send({ email });
    const secondToken = extractTokenFromLink(fakeEmailSender.sent[1]!.html);

    const oldAttempt = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: firstToken, newPassword: 'new-password-123' });
    expect(oldAttempt.status).toBe(401);
    expect(oldAttempt.body.error.code).toBe('INVALID_RESET_TOKEN');

    const newAttempt = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: secondToken, newPassword: 'new-password-123' });
    expect(newAttempt.status).toBe(200);
  });

  it('rejects an invalid payload with a structured 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/v1/auth/reset-password', () => {
  it('changes the password, and the old password stops working', async () => {
    const email = uniqueEmail('changes');
    const oldPassword = 'correct-horse-battery';
    const newPassword = 'new-correct-horse-battery';
    await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: oldPassword, name: 'Changes Test' });

    await request(app).post('/api/v1/auth/forgot-password').send({ email });
    const token = extractTokenFromLink(fakeEmailSender.sent[0]!.html);

    const resetRes = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword });
    expect(resetRes.status).toBe(200);

    const oldLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: oldPassword });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: newPassword });
    expect(newLogin.status).toBe(200);
  });

  it('revokes all existing refresh tokens on reset', async () => {
    const email = uniqueEmail('revoke');
    const password = 'correct-horse-battery';
    await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password, name: 'Revoke Test' });

    const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
    const setCookieHeader = loginRes.headers['set-cookie'];
    const cookieHeader = (Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader]).join(
      ';',
    );
    const oldRefreshCookie = /refreshToken=([^;]+)/.exec(cookieHeader)?.[1];

    await request(app).post('/api/v1/auth/forgot-password').send({ email });
    const token = extractTokenFromLink(fakeEmailSender.sent[0]!.html);
    await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'brand-new-password-456' });

    const refreshAttempt = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refreshToken=${oldRefreshCookie}`);
    expect(refreshAttempt.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const email = uniqueEmail('expired');
    await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'correct-horse-battery', name: 'Expired Test' });

    await request(app).post('/api/v1/auth/forgot-password').send({ email });
    const token = extractTokenFromLink(fakeEmailSender.sent[0]!.html);

    await prisma.passwordResetToken.updateMany({
      where: { user: { email } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'irrelevant-password-789' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_RESET_TOKEN');
  });

  it('rejects reuse of an already-used token', async () => {
    const email = uniqueEmail('reused');
    await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'correct-horse-battery', name: 'Reused Test' });

    await request(app).post('/api/v1/auth/forgot-password').send({ email });
    const token = extractTokenFromLink(fakeEmailSender.sent[0]!.html);

    const first = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'first-new-password-123' });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'second-new-password-456' });
    expect(second.status).toBe(401);
    expect(second.body.error.code).toBe('INVALID_RESET_TOKEN');
  });

  it('rejects a garbage token', async () => {
    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: 'not-a-real-token', newPassword: 'whatever-password-123' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_RESET_TOKEN');
  });

  it('rejects an invalid payload with a structured 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: '', newPassword: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
