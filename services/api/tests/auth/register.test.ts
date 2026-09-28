import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { verifyPassword } from '../../src/infrastructure/security/password';

const app = createApp();

// Unique-per-run prefix so this file's rows never collide with a previous
// run's leftovers and are trivially identifiable for cleanup.
const runId = Date.now();
const testEmails: string[] = [];

function uniqueEmail(label: string): string {
  const email = `test-register-${runId}-${label}@example.com`;
  testEmails.push(email);
  return email;
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  await prisma.$disconnect();
});

describe('POST /api/v1/auth/register', () => {
  it('creates a user and never returns the password hash', async () => {
    const email = uniqueEmail('success');

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'correct-horse-battery', name: 'Ada Lovelace' });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      email,
      name: 'Ada Lovelace',
      role: 'USER',
      status: 'ACTIVE',
    });
    expect(res.body.user.passwordHash).toBeUndefined();

    const stored = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(stored.passwordHash).not.toBe('correct-horse-battery');
    await expect(verifyPassword(stored.passwordHash, 'correct-horse-battery')).resolves.toBe(true);
  });

  it('normalizes email to lowercase', async () => {
    const email = uniqueEmail('case');

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: email.toUpperCase(), password: 'correct-horse-battery', name: 'Case Test' });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(email);
  });

  it('rejects an invalid payload with a structured 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'not-an-email', password: 'short', name: '' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toBeDefined();
  });

  it('rejects a duplicate email with 409', async () => {
    const email = uniqueEmail('duplicate');
    const payload = { email, password: 'correct-horse-battery', name: 'Dup Test' };

    const first = await request(app).post('/api/v1/auth/register').send(payload);
    expect(first.status).toBe(201);

    const second = await request(app).post('/api/v1/auth/register').send(payload);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('allows exactly one winner when two identical registrations race', async () => {
    const email = uniqueEmail('race');
    const payload = { email, password: 'correct-horse-battery', name: 'Race Test' };

    const [a, b] = await Promise.all([
      request(app).post('/api/v1/auth/register').send(payload),
      request(app).post('/api/v1/auth/register').send(payload),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);

    const rows = await prisma.user.findMany({ where: { email } });
    expect(rows).toHaveLength(1);
  });
});
