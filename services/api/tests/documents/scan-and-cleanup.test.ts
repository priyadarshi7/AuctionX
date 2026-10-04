import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import request from 'supertest';
import { createApp } from '../../src/app';
import { env } from '../../src/config/env';
import { prisma } from '../../src/infrastructure/database/prisma';
import { runOnce as sweepOrphans } from '../../src/infrastructure/jobs/documentOrphanSweeper';
import { ClamavUnavailableError, scanWithClamav } from '../../src/infrastructure/security/clamav';
import { basicScan, scanDocument } from '../../src/infrastructure/storage/documentScan';
import { headDocumentObject } from '../../src/infrastructure/storage/documents';
import { ensureBucketExists, s3Client } from '../../src/infrastructure/storage/s3Client';

const app = createApp();

const runId = Date.now();
let counter = 0;
const testEmails: string[] = [];
const createdAuctionIds: string[] = [];
const extraKeys: string[] = [];
const PASSWORD = 'correct-horse-battery';

function uniqueEmail(label: string): string {
  counter += 1;
  const email = `test-scan-${runId}-${counter}-${label}@example.com`.toLowerCase();
  testEmails.push(email);
  return email;
}

async function createUser(label: string) {
  const email = uniqueEmail(label);
  await request(app).post('/api/v1/auth/register').send({ email, password: PASSWORD, name: label });
  const user = await prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { id: user.id, accessToken: login.body.accessToken as string };
}

async function createDraft(token: string) {
  const res = await request(app)
    .post('/api/v1/auctions')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'Scan Lot', description: 'desc', category: 'OTHER', condition: 'GOOD', startingPriceCents: 1000 });
  const id = res.body.auction.id as string;
  createdAuctionIds.push(id);
  return id;
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF');
const EICAR = Buffer.from('%PDF-1.4\nX5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*\n');

async function putObject(auctionId: string, body: Buffer, contentType = 'application/pdf'): Promise<string> {
  const objectKey = `documents/${auctionId}/${randomUUID()}.pdf`;
  extraKeys.push(objectKey);
  await s3Client.send(new PutObjectCommand({ Bucket: env.S3_DOCS_BUCKET, Key: objectKey, Body: body, ContentType: contentType }));
  return objectKey;
}

const register = (token: string, auctionId: string, objectKey: string) =>
  request(app)
    .post(`/api/v1/auctions/${auctionId}/documents`)
    .set('Authorization', `Bearer ${token}`)
    .send({ objectKey, fileName: 'cert.pdf', contentType: 'application/pdf' });

beforeAll(async () => {
  await ensureBucketExists();
});

afterAll(async () => {
  await prisma.outboxEvent.deleteMany({ where: { key: { in: createdAuctionIds } } });
  await prisma.auction.deleteMany({ where: { id: { in: createdAuctionIds } } });
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  const { deleteDocumentObjects } = await import('../../src/infrastructure/storage/documents');
  await deleteDocumentObjects(extraKeys);
  await prisma.$disconnect();
});

describe('built-in document checks', () => {
  it('accepts a well-formed file of each type', () => {
    expect(basicScan(PDF, 'application/pdf').ok).toBe(true);
    expect(basicScan(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), 'image/jpeg').ok).toBe(true);
    expect(basicScan(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), 'image/png').ok).toBe(true);
    expect(basicScan(Buffer.from('RIFF\0\0\0\0WEBPVP8 '), 'image/webp').ok).toBe(true);
  });

  it('rejects bytes that are not the declared type (an executable renamed .pdf)', () => {
    expect(basicScan(Buffer.from('MZ\x90\0this is an exe'), 'application/pdf').ok).toBe(false);
    expect(basicScan(PDF, 'image/png').ok).toBe(false);
  });

  it('rejects the EICAR test string and PDFs with active content', () => {
    expect(basicScan(EICAR, 'application/pdf')).toMatchObject({ ok: false });
    const withScript = Buffer.from('%PDF-1.4\n1 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj');
    expect(basicScan(withScript, 'application/pdf')).toMatchObject({ ok: false });
    expect(basicScan(Buffer.from('%PDF-1.4\n/EmbeddedFile'), 'application/pdf').ok).toBe(false);
  });
});

describe('registration scans the real object', () => {
  it('refuses and deletes an infected upload, but accepts a clean one', async () => {
    const seller = await createUser('seller');
    const id = await createDraft(seller.accessToken);

    const bad = await putObject(id, EICAR);
    const res = await register(seller.accessToken, id, bad);
    expect(res.status).toBe(400);
    expect(await headDocumentObject(bad)).toBeNull();
    expect(await prisma.auctionDocument.count({ where: { auctionId: id } })).toBe(0);

    const good = await putObject(id, PDF);
    expect((await register(seller.accessToken, id, good)).status).toBe(201);
  });

  it('refuses a file whose bytes do not match the claimed type', async () => {
    const seller = await createUser('seller');
    const id = await createDraft(seller.accessToken);
    const fake = await putObject(id, Buffer.from('MZ\x90\0not a pdf at all'));
    const res = await register(seller.accessToken, id, fake);
    expect(res.status).toBe(400);
    expect(await headDocumentObject(fake)).toBeNull();
  });
});

// A stand-in clamd: implements just enough of INSTREAM to prove the client's
// framing (command, length-prefixed chunks, terminator) and reply handling.
function fakeClamd(reply: string): Promise<{ port: number; received: () => Buffer; close: () => void }> {
  return new Promise((resolve) => {
    let payload = Buffer.alloc(0);
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      let commandSeen = false;
      const parts: Buffer[] = [];
      socket.on('data', (data) => {
        buffer = Buffer.concat([buffer, data]);
        if (!commandSeen) {
          const nul = buffer.indexOf(0);
          if (nul === -1) return;
          expect(buffer.subarray(0, nul).toString()).toBe('zINSTREAM');
          buffer = buffer.subarray(nul + 1);
          commandSeen = true;
        }
        for (;;) {
          if (buffer.length < 4) return;
          const length = buffer.readUInt32BE(0);
          if (length === 0) {
            payload = Buffer.concat(parts);
            socket.end(reply);
            return;
          }
          if (buffer.length < 4 + length) return;
          parts.push(buffer.subarray(4, 4 + length));
          buffer = buffer.subarray(4 + length);
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        received: () => payload,
        close: () => server.close(),
      });
    });
  });
}

describe('ClamAV client', () => {
  it('streams the whole file and reads a clean verdict', async () => {
    const big = Buffer.alloc(200_000, 9); // several 64KB chunks
    const clamd = await fakeClamd('stream: OK\0');
    expect(await scanWithClamav(big, '127.0.0.1', clamd.port)).toEqual({ clean: true });
    expect(clamd.received().equals(big)).toBe(true);
    clamd.close();
  });

  it('reports the signature when clamd finds something', async () => {
    const clamd = await fakeClamd('stream: Win.Test.EICAR_HDB-1 FOUND\0');
    expect(await scanWithClamav(PDF, '127.0.0.1', clamd.port)).toEqual({ clean: false, signature: 'Win.Test.EICAR_HDB-1' });
    clamd.close();
  });

  it('treats an unreachable or confused daemon as unavailable, never as clean', async () => {
    await expect(scanWithClamav(PDF, '127.0.0.1', 1)).rejects.toBeInstanceOf(ClamavUnavailableError);
    const clamd = await fakeClamd('stream: scan error ERROR\0');
    await expect(scanWithClamav(PDF, '127.0.0.1', clamd.port)).rejects.toBeInstanceOf(ClamavUnavailableError);
    clamd.close();
  });

  it('fails closed in clamav mode when the daemon is down, and uses it when it is up', async () => {
    const mutable = env as { DOCUMENT_SCAN: string; CLAMAV_PORT: number };
    const original = { mode: mutable.DOCUMENT_SCAN, port: mutable.CLAMAV_PORT };
    try {
      mutable.DOCUMENT_SCAN = 'clamav';
      mutable.CLAMAV_PORT = 1;
      await expect(scanDocument(PDF, 'application/pdf')).rejects.toBeInstanceOf(ClamavUnavailableError);

      const clamd = await fakeClamd('stream: Some.Malware FOUND\0');
      mutable.CLAMAV_PORT = clamd.port;
      expect(await scanDocument(PDF, 'application/pdf')).toMatchObject({ ok: false });
      clamd.close();
    } finally {
      mutable.DOCUMENT_SCAN = original.mode;
      mutable.CLAMAV_PORT = original.port;
    }
  });
});

describe('cleaning up files nothing points at', () => {
  it('deleting an account removes its document files from the bucket', async () => {
    const seller = await createUser('leaving');
    const id = await createDraft(seller.accessToken);
    const key = await putObject(id, PDF);
    expect((await register(seller.accessToken, id, key)).status).toBe(201);
    expect(await headDocumentObject(key)).not.toBeNull();

    const res = await request(app).delete('/api/v1/auth/me').set('Authorization', `Bearer ${seller.accessToken}`);
    expect(res.status).toBe(204);
    expect(await prisma.auctionDocument.count({ where: { objectKey: key } })).toBe(0);
    expect(await headDocumentObject(key)).toBeNull();
  });

  it('the sweeper removes old unreferenced files, and keeps registered and recent ones', async () => {
    const seller = await createUser('sweeper');
    const id = await createDraft(seller.accessToken);
    const registered = await putObject(id, PDF);
    expect((await register(seller.accessToken, id, registered)).status).toBe(201);
    const orphan = await putObject(id, PDF);

    // A real "now": the just-uploaded orphan is too young to touch.
    await sweepOrphans();
    expect(await headDocumentObject(orphan)).not.toBeNull();

    // 25 hours later it is old enough; the registered file is still protected.
    await sweepOrphans(new Date(Date.now() + 25 * 60 * 60 * 1000));
    expect(await headDocumentObject(orphan)).toBeNull();
    expect(await headDocumentObject(registered)).not.toBeNull();
  });
});
