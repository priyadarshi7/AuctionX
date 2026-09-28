import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { env } from '../../src/config/env';

const app = createApp();

const runId = Date.now();
let counter = 0;
const testEmails: string[] = [];

function uniqueEmail(label: string): string {
  counter += 1;
  const email = `test-upload-presign-${runId}-${counter}-${label}@example.com`;
  testEmails.push(email);
  return email;
}

async function registerAndLogin() {
  const email = uniqueEmail('user');
  const password = 'correct-horse-battery';
  await request(app).post('/api/v1/auth/register').send({ email, password, name: 'Upload Test' });
  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { userId: user.id, accessToken: loginRes.body.accessToken as string };
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  await prisma.$disconnect();
});

describe('POST /api/v1/uploads/presign', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(app).post('/api/v1/uploads/presign').send({ contentType: 'image/png' });
    expect(res.status).toBe(401);
  });

  it('rejects an unsupported content type', async () => {
    const { accessToken } = await registerAndLogin();
    const res = await request(app)
      .post('/api/v1/uploads/presign')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ contentType: 'application/pdf' });
    expect(res.status).toBe(400);
  });

  it('returns a presigned POST scoped to the caller and pointing at our bucket', async () => {
    const { userId, accessToken } = await registerAndLogin();
    const res = await request(app)
      .post('/api/v1/uploads/presign')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.uploadUrl).toEqual(expect.any(String));
    expect(res.body.fields).toEqual(expect.any(Object));
    // Every S3 POST policy field must actually be present so the client can
    // submit them all as form fields alongside the file — not just "some
    // object came back."
    expect(res.body.fields.key).toEqual(expect.stringContaining(`auctions/${userId}/`));
    expect(res.body.fields.Policy).toEqual(expect.any(String));

    // The public URL a client will later put in an auction's `images` array
    // must both point at our configured bucket base AND be scoped under
    // THIS caller's own id — proving two different sellers can never collide
    // on (or overwrite) each other's objects.
    expect(res.body.publicUrl.startsWith(env.S3_PUBLIC_URL_BASE)).toBe(true);
    expect(res.body.publicUrl).toEqual(expect.stringContaining(`auctions/${userId}/`));
    expect(res.body.publicUrl.endsWith('.png')).toBe(true);
  });

  it('scopes different callers to different object key prefixes', async () => {
    const sellerA = await registerAndLogin();
    const sellerB = await registerAndLogin();

    const resA = await request(app)
      .post('/api/v1/uploads/presign')
      .set('Authorization', `Bearer ${sellerA.accessToken}`)
      .send({ contentType: 'image/jpeg' });
    const resB = await request(app)
      .post('/api/v1/uploads/presign')
      .set('Authorization', `Bearer ${sellerB.accessToken}`)
      .send({ contentType: 'image/jpeg' });

    expect(resA.body.publicUrl).toEqual(expect.stringContaining(`auctions/${sellerA.userId}/`));
    expect(resB.body.publicUrl).toEqual(expect.stringContaining(`auctions/${sellerB.userId}/`));
    expect(resA.body.publicUrl).not.toBe(resB.body.publicUrl);
  });

  // Local verification found that s3mock (docker-compose.yml's dev stand-in)
  // does NOT actually enforce a presigned POST policy's conditions — an
  // upload with a mismatched Content-Type or a file over the size limit
  // both succeeded against it when real S3/R2 would reject them (this is a
  // mock limitation, not expected/acceptable production behavior — see
  // ADR-0022). Since that means the enforcement itself can't be verified
  // end-to-end on this dev stack, this test instead verifies the SIGNED
  // POLICY DOCUMENT we generate is correct — the actual conditions AWS/R2's
  // real S3 implementation would check are present and well-formed, which
  // is the part genuinely within this codebase's control.
  it('signs a policy that actually constrains content-length-range and Content-Type', async () => {
    const { accessToken } = await registerAndLogin();
    const res = await request(app)
      .post('/api/v1/uploads/presign')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ contentType: 'image/jpeg' });

    const policy = JSON.parse(Buffer.from(res.body.fields.Policy as string, 'base64').toString('utf8')) as {
      conditions: unknown[];
    };

    expect(policy.conditions).toEqual(
      expect.arrayContaining([
        ['content-length-range', 0, 5 * 1024 * 1024],
        { 'Content-Type': 'image/jpeg' },
      ]),
    );
  });
});
