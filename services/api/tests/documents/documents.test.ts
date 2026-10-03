import { randomUUID } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import request from 'supertest';
import { createApp } from '../../src/app';
import { env } from '../../src/config/env';
import { prisma } from '../../src/infrastructure/database/prisma';
import { hashPassword } from '../../src/infrastructure/security/password';
import { headDocumentObject, MAX_DOCUMENT_BYTES } from '../../src/infrastructure/storage/documents';
import { ensureBucketExists, s3Client } from '../../src/infrastructure/storage/s3Client';
import { MAX_DOCUMENTS_PER_AUCTION } from '../../src/modules/documents/service';

const app = createApp();

const runId = Date.now();
let counter = 0;
const testEmails: string[] = [];
const createdAuctionIds: string[] = [];
const PASSWORD = 'correct-horse-battery';

function uniqueEmail(label: string): string {
  counter += 1;
  const email = `test-docs-${runId}-${counter}-${label}@example.com`.toLowerCase();
  testEmails.push(email);
  return email;
}

async function createAdmin() {
  const email = uniqueEmail('admin');
  await prisma.user.create({
    data: { email, passwordHash: await hashPassword(PASSWORD), name: 'Admin', role: 'ADMIN', emailVerifiedAt: new Date() },
  });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { accessToken: login.body.accessToken as string };
}

async function createUser(label: string) {
  const email = uniqueEmail(label);
  await request(app).post('/api/v1/auth/register').send({ email, password: PASSWORD, name: label });
  await prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { accessToken: login.body.accessToken as string };
}

async function createDraft(token: string, category = 'OTHER') {
  const res = await request(app)
    .post('/api/v1/auctions')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'Docs Lot', description: 'desc', category, condition: 'GOOD', startingPriceCents: 1000 });
  const id = res.body.auction.id as string;
  createdAuctionIds.push(id);
  return id;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// The real path: ask the API for a presigned POST, then upload to it exactly
// the way a browser would (fields first, file last).
async function presignAndUpload(token: string, auctionId: string, contentType = 'application/pdf', bytes = 2048) {
  const presign = await request(app)
    .post(`/api/v1/auctions/${auctionId}/documents/presign`)
    .set(auth(token))
    .send({ contentType });
  expect(presign.status).toBe(200);
  const form = new FormData();
  for (const [k, v] of Object.entries(presign.body.fields as Record<string, string>)) form.append(k, v);
  form.append('file', new Blob([Buffer.alloc(bytes, 7)], { type: contentType }), 'cert.pdf');
  const upload = await fetch(presign.body.uploadUrl as string, { method: 'POST', body: form });
  expect(upload.status).toBeLessThan(300);
  return presign.body.objectKey as string;
}

const register = (token: string, auctionId: string, body: Record<string, unknown>) =>
  request(app).post(`/api/v1/auctions/${auctionId}/documents`).set(auth(token)).send(body);

async function addDocument(token: string, auctionId: string) {
  const objectKey = await presignAndUpload(token, auctionId);
  const res = await register(token, auctionId, { objectKey, fileName: 'cert.pdf', contentType: 'application/pdf' });
  expect(res.status).toBe(201);
  return res.body.document as { id: string };
}

beforeAll(async () => {
  await ensureBucketExists();
  process.env.AUCTION_REVIEW_MODE = 'untrusted';
});

afterAll(async () => {
  process.env.AUCTION_REVIEW_MODE = 'off';
  await prisma.outboxEvent.deleteMany({ where: { key: { in: createdAuctionIds } } });
  await prisma.auction.deleteMany({ where: { id: { in: createdAuctionIds } } });
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  await prisma.$disconnect();
});

describe('document upload', () => {
  it('requires login and rejects an unsupported type', async () => {
    const seller = await createUser('seller');
    const id = await createDraft(seller.accessToken);

    expect((await request(app).post(`/api/v1/auctions/${id}/documents/presign`).send({ contentType: 'application/pdf' })).status).toBe(401);
    const bad = await request(app)
      .post(`/api/v1/auctions/${id}/documents/presign`)
      .set(auth(seller.accessToken))
      .send({ contentType: 'application/x-msdownload' });
    expect(bad.status).toBe(400);
  });

  it('only the owner can upload, and the key is scoped to the auction', async () => {
    const seller = await createUser('seller');
    const stranger = await createUser('stranger');
    const id = await createDraft(seller.accessToken);

    const denied = await request(app)
      .post(`/api/v1/auctions/${id}/documents/presign`)
      .set(auth(stranger.accessToken))
      .send({ contentType: 'application/pdf' });
    expect(denied.status).toBe(404);

    const ok = await request(app)
      .post(`/api/v1/auctions/${id}/documents/presign`)
      .set(auth(seller.accessToken))
      .send({ contentType: 'application/pdf' });
    expect(ok.status).toBe(200);
    expect(ok.body.objectKey).toMatch(new RegExp(`^documents/${id}/[0-9a-f-]+\\.pdf$`));
  });

  it('registers a real upload using the size stored in the bucket, and lists it with a signed link', async () => {
    const seller = await createUser('seller');
    const id = await createDraft(seller.accessToken);
    const objectKey = await presignAndUpload(seller.accessToken, id, 'application/pdf', 4096);

    const res = await register(seller.accessToken, id, {
      objectKey,
      fileName: 'Certificate of Authenticity.pdf',
      contentType: 'application/pdf',
    });
    expect(res.status).toBe(201);
    expect(res.body.document).toMatchObject({ fileName: 'Certificate of Authenticity.pdf', sizeBytes: 4096 });
    expect(res.body.document.url).toBeUndefined();

    const list = await request(app).get(`/api/v1/auctions/${id}/documents`).set(auth(seller.accessToken));
    expect(list.status).toBe(200);
    expect(list.body.documents).toHaveLength(1);
    const url = new URL(list.body.documents[0].url as string);
    expect(url.pathname).toContain(`/${env.S3_DOCS_BUCKET}/${objectKey}`);
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(list.body.documents[0].url).not.toContain(env.S3_PUBLIC_URL_BASE);

    const fetched = await fetch(url);
    expect(fetched.status).toBe(200);
    expect((await fetched.arrayBuffer()).byteLength).toBe(4096);
  });

  it('rejects keys it did not issue for this auction, missing uploads, and duplicates', async () => {
    const seller = await createUser('seller');
    const id = await createDraft(seller.accessToken);
    const other = await createDraft(seller.accessToken);
    const otherKey = await presignAndUpload(seller.accessToken, other);

    const foreign = await register(seller.accessToken, id, { objectKey: otherKey, fileName: 'x.pdf', contentType: 'application/pdf' });
    expect(foreign.status).toBe(400);

    const missing = await register(seller.accessToken, id, {
      objectKey: `documents/${id}/${randomUUID()}.pdf`,
      fileName: 'x.pdf',
      contentType: 'application/pdf',
    });
    expect(missing.status).toBe(400);

    const key = await presignAndUpload(seller.accessToken, id);
    expect((await register(seller.accessToken, id, { objectKey: key, fileName: 'a.pdf', contentType: 'application/pdf' })).status).toBe(201);
    const dup = await register(seller.accessToken, id, { objectKey: key, fileName: 'a.pdf', contentType: 'application/pdf' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DOCUMENT_ALREADY_REGISTERED');
  });

  it('measures the real object: an oversized file is refused and removed even if the client lies', async () => {
    const seller = await createUser('seller');
    const id = await createDraft(seller.accessToken);
    const objectKey = `documents/${id}/${randomUUID()}.pdf`;
    await s3Client.send(
      new PutObjectCommand({
        Bucket: env.S3_DOCS_BUCKET,
        Key: objectKey,
        Body: Buffer.alloc(MAX_DOCUMENT_BYTES + 1024, 1),
        ContentType: 'application/pdf',
      }),
    );

    const res = await register(seller.accessToken, id, { objectKey, fileName: 'huge.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
    expect(await headDocumentObject(objectKey)).toBeNull();
  });

  it(`caps documents at ${MAX_DOCUMENTS_PER_AUCTION} per auction`, async () => {
    const seller = await createUser('seller');
    const id = await createDraft(seller.accessToken);
    for (let i = 0; i < MAX_DOCUMENTS_PER_AUCTION; i += 1) await addDocument(seller.accessToken, id);

    const extra = await request(app)
      .post(`/api/v1/auctions/${id}/documents/presign`)
      .set(auth(seller.accessToken))
      .send({ contentType: 'application/pdf' });
    expect(extra.status).toBe(409);
    expect(extra.body.error.code).toBe('TOO_MANY_DOCUMENTS');
  });
});

describe('document access', () => {
  it('is visible to the owner and admins only, never to anyone else or anonymous', async () => {
    const admin = await createAdmin();
    const seller = await createUser('seller');
    const stranger = await createUser('stranger');
    const id = await createDraft(seller.accessToken);
    await addDocument(seller.accessToken, id);

    const get = (token?: string) => {
      const r = request(app).get(`/api/v1/auctions/${id}/documents`);
      return token ? r.set(auth(token)) : r;
    };
    expect((await get(seller.accessToken)).body.documents).toHaveLength(1);
    expect((await get(admin.accessToken)).body.documents).toHaveLength(1);
    expect((await get(stranger.accessToken)).status).toBe(404);
    expect((await get()).status).toBe(401);
  });
});

describe('removing and locking', () => {
  it('lets the owner delete a document from a draft, but not someone else’s or a missing one', async () => {
    const seller = await createUser('seller');
    const stranger = await createUser('stranger');
    const id = await createDraft(seller.accessToken);
    const doc = await addDocument(seller.accessToken, id);
    const row = await prisma.auctionDocument.findUniqueOrThrow({ where: { id: doc.id } });

    expect((await request(app).delete(`/api/v1/auctions/${id}/documents/${doc.id}`).set(auth(stranger.accessToken))).status).toBe(404);
    expect((await request(app).delete(`/api/v1/auctions/${id}/documents/${randomUUID()}`).set(auth(seller.accessToken))).status).toBe(404);

    expect((await request(app).delete(`/api/v1/auctions/${id}/documents/${doc.id}`).set(auth(seller.accessToken))).status).toBe(204);
    expect(await prisma.auctionDocument.count({ where: { id: doc.id } })).toBe(0);
    expect(await headDocumentObject(row.objectKey)).toBeNull();
  });

  it('freezes the paperwork once the listing is submitted, so approval covers exactly what was submitted', async () => {
    const seller = await createUser('seller');
    const id = await createDraft(seller.accessToken);
    const doc = await addDocument(seller.accessToken, id);
    expect((await request(app).post(`/api/v1/auctions/${id}/submit`).set(auth(seller.accessToken)).send({ durationSeconds: 60 })).status).toBe(200);

    const presign = await request(app)
      .post(`/api/v1/auctions/${id}/documents/presign`)
      .set(auth(seller.accessToken))
      .send({ contentType: 'application/pdf' });
    expect(presign.status).toBe(409);
    expect(presign.body.error.code).toBe('DOCUMENTS_LOCKED');
    const del = await request(app).delete(`/api/v1/auctions/${id}/documents/${doc.id}`).set(auth(seller.accessToken));
    expect(del.status).toBe(409);
    expect(await prisma.auctionDocument.count({ where: { id: doc.id } })).toBe(1);
  });
});

describe('documents and the review rule', () => {
  it('a watch can only be submitted once it has a document, and the admin can then read it', async () => {
    const admin = await createAdmin();
    const seller = await createUser('seller');
    const id = await createDraft(seller.accessToken, 'WATCHES');
    const submit = () =>
      request(app).post(`/api/v1/auctions/${id}/submit`).set(auth(seller.accessToken)).send({ durationSeconds: 60 });

    const without = await submit();
    expect(without.status).toBe(409);
    expect(without.body.error.code).toBe('DOCUMENTS_REQUIRED');

    await addDocument(seller.accessToken, id);
    const withDoc = await submit();
    expect(withDoc.status).toBe(200);
    expect(withDoc.body.auction.status).toBe('PENDING_REVIEW');

    const seen = await request(app).get(`/api/v1/auctions/${id}/documents`).set(auth(admin.accessToken));
    expect(seen.body.documents).toHaveLength(1);
    expect(seen.body.documents[0].url).toContain('X-Amz-Signature');
  });
});
