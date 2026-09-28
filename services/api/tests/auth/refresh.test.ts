import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';

const app = createApp();

const runId = Date.now();
const testEmails: string[] = [];

function uniqueEmail(label: string): string {
  const email = `test-refresh-${runId}-${label}@example.com`;
  testEmails.push(email);
  return email;
}

function extractCookie(res: request.Response): string {
  const setCookie = res.headers['set-cookie'];
  const header = (Array.isArray(setCookie) ? setCookie : [setCookie]).join(';');
  const match = /refreshToken=([^;]+)/.exec(header);
  if (!match) throw new Error('refreshToken cookie not found in response');
  return match[1] as string;
}

async function registerAndLogin(email: string, password = 'correct-horse-battery') {
  await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password, name: 'Refresh Test' });
  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
  return { loginRes, refreshCookie: extractCookie(loginRes) };
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  await prisma.$disconnect();
});

describe('POST /api/v1/auth/refresh', () => {
  it('rotates the refresh token and issues a new access token', async () => {
    const email = uniqueEmail('rotate');
    const { refreshCookie } = await registerAndLogin(email);

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refreshToken=${refreshCookie}`);

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));

    const newCookie = extractCookie(res);
    expect(newCookie).not.toBe(refreshCookie);
  });

  it('rejects a missing refresh token', async () => {
    const res = await request(app).post('/api/v1/auth/refresh');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('rejects an unrecognized refresh token', async () => {
    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', 'refreshToken=not-a-real-token');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('detects reuse of an already-rotated token and revokes the whole chain', async () => {
    const email = uniqueEmail('reuse');
    const { refreshCookie: original } = await registerAndLogin(email);

    // First use: legitimate rotation.
    const firstRefresh = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refreshToken=${original}`);
    expect(firstRefresh.status).toBe(200);
    const rotated = extractCookie(firstRefresh);

    // Second use of the SAME original token — simulates a stolen copy (or a
    // lost-response retry) being replayed after the legitimate rotation.
    const reuseAttempt = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refreshToken=${original}`);
    expect(reuseAttempt.status).toBe(401);
    expect(reuseAttempt.body.error.code).toBe('REFRESH_TOKEN_REUSED');

    // The token issued by the FIRST (legitimate) rotation must now be dead
    // too — proving the whole family was revoked, not just the reused one.
    const afterFamilyRevoked = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refreshToken=${rotated}`);
    expect(afterFamilyRevoked.status).toBe(401);
    expect(afterFamilyRevoked.body.error.code).toBe('REFRESH_TOKEN_REUSED');
  });

  it('revoking a family is O(1): a long rotation chain still fully revokes on reuse', async () => {
    const email = uniqueEmail('longchain');
    const { refreshCookie: original } = await registerAndLogin(email);

    let cookie = original;
    const chain = [original];
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', `refreshToken=${cookie}`);
      expect(res.status).toBe(200);
      cookie = extractCookie(res);
      chain.push(cookie);
    }

    // Replay the very first token in the (now 6-long) chain.
    const reuse = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refreshToken=${chain[0]}`);
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('REFRESH_TOKEN_REUSED');

    // The most recently issued token — several rotations removed from the
    // one that triggered detection — must also be dead.
    const latestDead = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refreshToken=${chain[chain.length - 1]}`);
    expect(latestDead.status).toBe(401);
    expect(latestDead.body.error.code).toBe('REFRESH_TOKEN_REUSED');
  });

  it('two concurrent refreshes of the SAME token never both succeed (ADR-0019)', async () => {
    const email = uniqueEmail('concurrent');
    const { refreshCookie: original } = await registerAndLogin(email);

    // Simulates two browser tabs both refreshing at nearly the same instant
    // — fired via Promise.all, not sequentially, so this exercises real
    // concurrent DB transactions rather than two requests that merely look
    // concurrent in test code. Before the row-lock fix, both could read the
    // token as not-yet-revoked and both successfully rotate, silently
    // forking one token into two live sessions with no error to either
    // caller — the assertions below rule that out directly.
    const [resA, resB] = await Promise.all([
      request(app).post('/api/v1/auth/refresh').set('Cookie', `refreshToken=${original}`),
      request(app).post('/api/v1/auth/refresh').set('Cookie', `refreshToken=${original}`),
    ]);

    const statuses = [resA.status, resB.status].sort();
    // Exactly one request wins the race and rotates; the other MUST observe
    // the row already revoked and take the reuse-detection path — it must
    // never also succeed with 200.
    expect(statuses).toEqual([200, 401]);

    const [winner, loser] = resA.status === 200 ? [resA, resB] : [resB, resA];
    expect(loser.body.error.code).toBe('REFRESH_TOKEN_REUSED');

    // Reuse detection must have killed the whole family — including the
    // token the winner was JUST issued. If it didn't, the fork would have
    // gone undetected and the winner's new session would survive unharmed.
    const winnerCookie = extractCookie(winner);
    const afterFamilyRevoked = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refreshToken=${winnerCookie}`);
    expect(afterFamilyRevoked.status).toBe(401);
    expect(afterFamilyRevoked.body.error.code).toBe('REFRESH_TOKEN_REUSED');
  });
});
