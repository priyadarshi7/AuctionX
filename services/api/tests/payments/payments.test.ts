import { createHmac } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { runOnce } from '../../src/infrastructure/jobs/auctionClosingWorker';
import { env } from '../../src/config/env';

const app = createApp();

const runId = Date.now();
let counter = 0;
const testEmails: string[] = [];
const createdAuctionIds: string[] = [];

function uniqueEmail(label: string): string {
  counter += 1;
  const email = `test-payments-${runId}-${counter}-${label}@example.com`;
  testEmails.push(email);
  return email;
}

async function registerAndLogin(label = 'user') {
  const email = uniqueEmail(label);
  const password = 'correct-horse-battery';
  await request(app).post('/api/v1/auth/register').send({ email, password, name: 'Payments Test' });
  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
  return { accessToken: loginRes.body.accessToken as string };
}

// Builds a real ENDED + SOLD auction with a PENDING_PAYMENT Order behind
// it, through the actual API + real closing worker — not a direct DB
// insert — so these tests exercise the real path an Order comes from
// (ADR-0023), not a synthetic shortcut.
async function createOrderViaWonAuction(sellerToken: string, buyerToken: string, amountCents = 2000) {
  const createRes = await request(app)
    .post('/api/v1/auctions')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({
      title: 'Payments Test Lot',
      description: 'desc',
      category: 'OTHER',
      condition: 'GOOD',
      startingPriceCents: 1000,
    });
  const auctionId = createRes.body.auction.id as string;
  createdAuctionIds.push(auctionId);

  await request(app)
    .post(`/api/v1/auctions/${auctionId}/publish`)
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ endTime: new Date(Date.now() + 3_600_000).toISOString() });
  await request(app).post(`/api/v1/auctions/${auctionId}/start`).set('Authorization', `Bearer ${sellerToken}`);

  const bidRes = await request(app)
    .post(`/api/v1/auctions/${auctionId}/bids`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ amountCents, idempotencyKey: `${auctionId}-${amountCents}` });
  expect(bidRes.status).toBe(201);

  await prisma.auction.update({ where: { id: auctionId }, data: { endTime: new Date(Date.now() - 1_000) } });
  await runOnce();

  const order = await prisma.order.findUniqueOrThrow({ where: { auctionId } });
  return { auctionId, order };
}

function signMockPayload(body: Buffer): string {
  return createHmac('sha256', env.MOCK_PAYMENT_WEBHOOK_SECRET).update(body).digest('hex');
}

async function waitForOrderStatus(orderId: string, status: string, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    if (order.status === status) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for order ${orderId} to reach status ${status} (was ${order.status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

afterAll(async () => {
  await prisma.payment.deleteMany({ where: { order: { auctionId: { in: createdAuctionIds } } } });
  await prisma.order.deleteMany({ where: { auctionId: { in: createdAuctionIds } } });
  await prisma.bid.deleteMany({ where: { auctionId: { in: createdAuctionIds } } });
  await prisma.auction.deleteMany({ where: { id: { in: createdAuctionIds } } });
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  await prisma.$disconnect();
});

describe('orders + payments', () => {
  it('lists an order for both buyer and seller, and hides it from a third party', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const stranger = await registerAndLogin('stranger');
    const { order } = await createOrderViaWonAuction(seller.accessToken, buyer.accessToken);

    const buyerList = await request(app).get('/api/v1/orders').set('Authorization', `Bearer ${buyer.accessToken}`);
    expect(buyerList.body.orders.map((o: { id: string }) => o.id)).toContain(order.id);

    const sellerList = await request(app).get('/api/v1/orders').set('Authorization', `Bearer ${seller.accessToken}`);
    expect(sellerList.body.orders.map((o: { id: string }) => o.id)).toContain(order.id);

    const buyerGet = await request(app)
      .get(`/api/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${buyer.accessToken}`);
    expect(buyerGet.status).toBe(200);
    expect(buyerGet.body.order.status).toBe('PENDING_PAYMENT');

    const strangerGet = await request(app)
      .get(`/api/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${stranger.accessToken}`);
    expect(strangerGet.status).toBe(403);
  });

  it('rejects a non-buyer trying to pay', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const { order } = await createOrderViaWonAuction(seller.accessToken, buyer.accessToken);

    const sellerPay = await request(app)
      .post(`/api/v1/orders/${order.id}/pay`)
      .set('Authorization', `Bearer ${seller.accessToken}`)
      .send({ idempotencyKey: 'seller-attempt-1' });
    expect(sellerPay.status).toBe(403);
  });

  it('completes the full pay -> webhook -> PAID flow end to end', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const { order } = await createOrderViaWonAuction(seller.accessToken, buyer.accessToken, 2500);

    const payRes = await request(app)
      .post(`/api/v1/orders/${order.id}/pay`)
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ idempotencyKey: 'full-flow-1' });
    expect(payRes.status).toBe(200);
    expect(payRes.body.payment.status).toBe('PENDING');
    expect(payRes.body.payment.amountCents).toBe(2500);

    // MockPaymentProvider fires its simulated webhook ~300ms later, through
    // the exact same handlePaymentWebhook function the real HTTP route
    // calls (see mockProvider.ts / modules/payments/service.ts) — this
    // proves the full async loop actually closes, not just that the intent
    // was created.
    await waitForOrderStatus(order.id, 'PAID');

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: payRes.body.payment.id } });
    expect(payment.status).toBe('SUCCEEDED');
  });

  it('is idempotent: two pay requests before the webhook fires return the same Payment', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const { order } = await createOrderViaWonAuction(seller.accessToken, buyer.accessToken);

    const [first, second] = await Promise.all([
      request(app)
        .post(`/api/v1/orders/${order.id}/pay`)
        .set('Authorization', `Bearer ${buyer.accessToken}`)
        .send({ idempotencyKey: 'concurrent-key' }),
      request(app)
        .post(`/api/v1/orders/${order.id}/pay`)
        .set('Authorization', `Bearer ${buyer.accessToken}`)
        .send({ idempotencyKey: 'concurrent-key' }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.payment.id).toBe(second.body.payment.id);

    const paymentCount = await prisma.payment.count({ where: { orderId: order.id } });
    expect(paymentCount).toBe(1);
  });

  it('rejects paying an order that is already PAID', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const { order } = await createOrderViaWonAuction(seller.accessToken, buyer.accessToken);

    await request(app)
      .post(`/api/v1/orders/${order.id}/pay`)
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ idempotencyKey: 'first-attempt' });
    await waitForOrderStatus(order.id, 'PAID');

    const secondAttempt = await request(app)
      .post(`/api/v1/orders/${order.id}/pay`)
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ idempotencyKey: 'second-attempt' });
    expect(secondAttempt.status).toBe(409);
    expect(secondAttempt.body.error.code).toBe('ORDER_NOT_PAYABLE');
  });

  // Content-Type is deliberately 'application/octet-stream', not
  // 'application/json', on every request below — supertest/superagent
  // JSON.stringifies a Buffer payload (producing {"type":"Buffer","data":
  // [...]}) when the Content-Type it's given says json, instead of writing
  // the raw bytes. express.raw({ type: '*/*' }) on the real route accepts
  // any content type, so this only affects the test client, not production
  // behavior — but it means byte-for-byte signature testing here needs a
  // content type superagent won't try to "help" with. Found by comparing a
  // real curl request (worked) against supertest (didn't) and diffing what
  // the server actually received.
  describe('POST /api/v1/webhooks/payments/mock', () => {
    it('rejects a request with no signature header', async () => {
      const body = Buffer.from(JSON.stringify({ type: 'payment.succeeded', providerRef: 'mock_pi_fake' }));
      const res = await request(app)
        .post('/api/v1/webhooks/payments/mock')
        .set('Content-Type', 'application/octet-stream')
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_WEBHOOK');
    });

    it('rejects a request with a wrong signature', async () => {
      const body = Buffer.from(JSON.stringify({ type: 'payment.succeeded', providerRef: 'mock_pi_fake' }));
      const res = await request(app)
        .post('/api/v1/webhooks/payments/mock')
        .set('Content-Type', 'application/octet-stream')
        .set('x-mock-signature', 'a'.repeat(64))
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_WEBHOOK');
    });

    it('accepts a correctly-signed event for an unknown providerRef as a harmless no-op', async () => {
      const body = Buffer.from(JSON.stringify({ type: 'payment.succeeded', providerRef: 'mock_pi_does_not_exist' }));
      const res = await request(app)
        .post('/api/v1/webhooks/payments/mock')
        .set('Content-Type', 'application/octet-stream')
        .set('x-mock-signature', signMockPayload(body))
        .send(body);
      expect(res.status).toBe(200);
    });

    it('is idempotent: replaying the same succeeded event twice only applies once', async () => {
      const seller = await registerAndLogin('seller');
      const buyer = await registerAndLogin('buyer');
      const { order } = await createOrderViaWonAuction(seller.accessToken, buyer.accessToken);

      const payRes = await request(app)
        .post(`/api/v1/orders/${order.id}/pay`)
        .set('Authorization', `Bearer ${buyer.accessToken}`)
        .send({ idempotencyKey: 'replay-test' });
      const providerRef = (await prisma.payment.findUniqueOrThrow({ where: { id: payRes.body.payment.id } }))
        .providerRef;

      const body = Buffer.from(JSON.stringify({ type: 'payment.succeeded', providerRef }));
      const signature = signMockPayload(body);

      const first = await request(app)
        .post('/api/v1/webhooks/payments/mock')
        .set('Content-Type', 'application/octet-stream')
        .set('x-mock-signature', signature)
        .send(body);
      expect(first.status).toBe(200);

      const second = await request(app)
        .post('/api/v1/webhooks/payments/mock')
        .set('Content-Type', 'application/octet-stream')
        .set('x-mock-signature', signature)
        .send(body);
      expect(second.status).toBe(200);

      const order2 = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(order2.status).toBe('PAID');
    });
  });
});
