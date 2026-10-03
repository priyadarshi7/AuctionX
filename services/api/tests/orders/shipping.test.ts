import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { runOnce as runClosingWorkerOnce } from '../../src/infrastructure/jobs/auctionClosingWorker';
import { runOnce as runDeadlineWorkerOnce } from '../../src/infrastructure/jobs/orderPaymentDeadlineWorker';
import { paymentProvider } from '../../src/infrastructure/payments';
import { ORDER_PAYMENT_WINDOW_MS } from '../../src/modules/orders/lifecycle';
import { applyPaymentWebhookEvent } from '../../src/modules/payments/repository';

const app = createApp();

const runId = Date.now();
let counter = 0;
const testEmails: string[] = [];
const createdAuctionIds: string[] = [];

function uniqueEmail(label: string): string {
  counter += 1;
  const email = `test-shipping-${runId}-${counter}-${label}@example.com`.toLowerCase();
  testEmails.push(email);
  return email;
}

async function registerAndLogin(label = 'user') {
  const email = uniqueEmail(label);
  const password = 'correct-horse-battery';
  await request(app).post('/api/v1/auth/register').send({ email, password, name: 'Shipping Test' });
  await prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
  return { accessToken: loginRes.body.accessToken as string };
}

// A real SOLD auction -> real PENDING_PAYMENT order via the closing worker
// (same as the payments tests). `paid` flips it straight to PAID: the
// pay -> webhook path is covered by payments.test.ts, not repeated here.
async function createOrder(sellerToken: string, buyerToken: string, opts: { paid: boolean }) {
  const createRes = await request(app)
    .post('/api/v1/auctions')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ title: 'Shipping Test Lot', description: 'desc', category: 'OTHER', condition: 'GOOD', startingPriceCents: 1000 });
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
    .send({ amountCents: 2000, idempotencyKey: `${auctionId}-bid` });
  expect(bidRes.status).toBe(201);

  await prisma.auction.update({ where: { id: auctionId }, data: { endTime: new Date(Date.now() - 1_000) } });
  await runClosingWorkerOnce();

  let order = await prisma.order.findUniqueOrThrow({ where: { auctionId } });
  if (opts.paid) {
    order = await prisma.order.update({ where: { id: order.id }, data: { status: 'PAID' } });
  }
  return order;
}

const ship = (orderId: string, token: string, body: Record<string, unknown> = { carrier: 'DHL', trackingNumber: 'TRK123' }) =>
  request(app).post(`/api/v1/orders/${orderId}/ship`).set('Authorization', `Bearer ${token}`).send(body);

const confirmDelivery = (orderId: string, token: string) =>
  request(app).post(`/api/v1/orders/${orderId}/confirm-delivery`).set('Authorization', `Bearer ${token}`);

// Lifecycle events must actually reach the outbox (that's what the
// notification consumer reads) — asserting on the HTTP response alone would
// pass even if the event were silently never written.
async function orderEvents(orderId: string, type: string) {
  const rows = await prisma.outboxEvent.findMany({ where: { key: orderId } });
  return rows.filter((r) => (r.payload as { type: string }).type === type);
}

afterAll(async () => {
  const orders = await prisma.order.findMany({ where: { auctionId: { in: createdAuctionIds } }, select: { id: true } });
  await prisma.outboxEvent.deleteMany({ where: { key: { in: [...orders.map((o) => o.id), ...createdAuctionIds] } } });
  await prisma.payment.deleteMany({ where: { orderId: { in: orders.map((o) => o.id) } } });
  await prisma.order.deleteMany({ where: { auctionId: { in: createdAuctionIds } } });
  await prisma.bid.deleteMany({ where: { auctionId: { in: createdAuctionIds } } });
  await prisma.auction.deleteMany({ where: { id: { in: createdAuctionIds } } });
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  await prisma.$disconnect();
});

describe('order payment deadline', () => {
  it('sets paymentDueAt to the payment window after the order is created', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const order = await createOrder(seller.accessToken, buyer.accessToken, { paid: false });

    const expected = Date.now() + ORDER_PAYMENT_WINDOW_MS;
    expect(order.paymentDueAt).not.toBeNull();
    expect(Math.abs(order.paymentDueAt!.getTime() - expected)).toBeLessThan(60_000);
  });
});

describe('POST /api/v1/orders/:id/ship', () => {
  it('lets only the seller ship', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const stranger = await registerAndLogin('stranger');
    const order = await createOrder(seller.accessToken, buyer.accessToken, { paid: true });

    expect((await ship(order.id, buyer.accessToken)).status).toBe(403);
    expect((await ship(order.id, stranger.accessToken)).status).toBe(403);
    expect((await ship('00000000-0000-0000-0000-000000000000', seller.accessToken)).status).toBe(404);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PAID');
  });

  it('rejects shipping an order that has not been paid', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const order = await createOrder(seller.accessToken, buyer.accessToken, { paid: false });

    const res = await ship(order.id, seller.accessToken);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_NOT_SHIPPABLE');
  });

  it('rejects a missing or blank carrier / tracking number', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const order = await createOrder(seller.accessToken, buyer.accessToken, { paid: true });

    expect((await ship(order.id, seller.accessToken, { carrier: 'DHL' })).status).toBe(400);
    expect((await ship(order.id, seller.accessToken, { carrier: '  ', trackingNumber: 'X' })).status).toBe(400);
  });

  it('marks a paid order SHIPPED, records the details, and writes exactly one order.shipped event', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const order = await createOrder(seller.accessToken, buyer.accessToken, { paid: true });

    const res = await ship(order.id, seller.accessToken, { carrier: '  DHL ', trackingNumber: 'TRK-42' });
    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({ status: 'SHIPPED', carrier: 'DHL', trackingNumber: 'TRK-42' });
    expect(res.body.order.shippedAt).toEqual(expect.any(String));

    const events = await orderEvents(order.id, 'order.shipped');
    expect(events).toHaveLength(1);
    expect(events[0]!.topic).toBe('payment-events');
    expect(events[0]!.payload).toMatchObject({
      orderId: order.id,
      buyerId: order.buyerId,
      sellerId: order.sellerId,
      carrier: 'DHL',
      trackingNumber: 'TRK-42',
    });
  });

  it('treats an identical repeat as a success without a second event, but rejects different details', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const order = await createOrder(seller.accessToken, buyer.accessToken, { paid: true });

    expect((await ship(order.id, seller.accessToken)).status).toBe(200);
    expect((await ship(order.id, seller.accessToken)).status).toBe(200);
    expect(await orderEvents(order.id, 'order.shipped')).toHaveLength(1);

    const different = await ship(order.id, seller.accessToken, { carrier: 'UPS', trackingNumber: 'OTHER' });
    expect(different.status).toBe(409);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).carrier).toBe('DHL');
  });

  it('lets two simultaneous identical requests both succeed while shipping exactly once', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const order = await createOrder(seller.accessToken, buyer.accessToken, { paid: true });

    const [a, b] = await Promise.all([ship(order.id, seller.accessToken), ship(order.id, seller.accessToken)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await orderEvents(order.id, 'order.shipped')).toHaveLength(1);
  });
});

describe('POST /api/v1/orders/:id/confirm-delivery', () => {
  it('lets only the buyer confirm, and only after shipping', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const order = await createOrder(seller.accessToken, buyer.accessToken, { paid: true });

    const early = await confirmDelivery(order.id, buyer.accessToken);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('ORDER_NOT_DELIVERABLE');

    await ship(order.id, seller.accessToken);
    expect((await confirmDelivery(order.id, seller.accessToken)).status).toBe(403);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('SHIPPED');
  });

  it('marks a shipped order DELIVERED with exactly one order.delivered event, and is idempotent', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const order = await createOrder(seller.accessToken, buyer.accessToken, { paid: true });
    await ship(order.id, seller.accessToken);

    const res = await confirmDelivery(order.id, buyer.accessToken);
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('DELIVERED');
    expect(res.body.order.deliveredAt).toEqual(expect.any(String));

    expect((await confirmDelivery(order.id, buyer.accessToken)).status).toBe(200);
    const events = await orderEvents(order.id, 'order.delivered');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ orderId: order.id, sellerId: order.sellerId, buyerId: order.buyerId });
  });
});

// The deadline worker is global (it scans every overdue order, including any
// left behind by other test files or a dev database), so assertions here are
// only ever about the specific orders each test created.
describe('order payment deadline worker', () => {
  const makeOverdue = (orderId: string) =>
    prisma.order.update({ where: { id: orderId }, data: { paymentDueAt: new Date(Date.now() - 1_000) } });
  const fresh = (orderId: string) => prisma.order.findUniqueOrThrow({ where: { id: orderId } });

  it('cancels an overdue unpaid order with PAYMENT_TIMEOUT and writes exactly one order.cancelled event', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const order = await createOrder(seller.accessToken, buyer.accessToken, { paid: false });
    await makeOverdue(order.id);

    await runDeadlineWorkerOnce();
    await runDeadlineWorkerOnce(); // a second tick must be a no-op

    const after = await fresh(order.id);
    expect(after.status).toBe('CANCELLED');
    expect(after.cancelReason).toBe('PAYMENT_TIMEOUT');
    expect(after.cancelledAt).not.toBeNull();
    const events = await orderEvents(order.id, 'order.cancelled');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ orderId: order.id, buyerId: order.buyerId, sellerId: order.sellerId, reason: 'PAYMENT_TIMEOUT' });
  });

  it('leaves alone an unpaid order that is not yet overdue, and a paid order past its deadline', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const notDue = await createOrder(seller.accessToken, buyer.accessToken, { paid: false });
    const paid = await createOrder(seller.accessToken, buyer.accessToken, { paid: true });
    await makeOverdue(paid.id);

    await runDeadlineWorkerOnce();

    expect((await fresh(notDue.id)).status).toBe('PENDING_PAYMENT');
    expect((await fresh(paid.id)).status).toBe('PAID');
  });

  it('does not cancel while a recent payment attempt is still in flight, but does once it is stale', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const order = await createOrder(seller.accessToken, buyer.accessToken, { paid: false });
    await makeOverdue(order.id);
    const payment = await prisma.payment.create({
      data: { orderId: order.id, provider: 'test', providerRef: `ref-${order.id}`, amountCents: order.amountCents, idempotencyKey: 'k', status: 'PENDING' },
    });

    await runDeadlineWorkerOnce();
    expect((await fresh(order.id)).status).toBe('PENDING_PAYMENT');

    await prisma.payment.update({ where: { id: payment.id }, data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } });
    await runDeadlineWorkerOnce();
    expect((await fresh(order.id)).status).toBe('CANCELLED');
  });

  it('refuses a payment on a cancelled order', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const order = await createOrder(seller.accessToken, buyer.accessToken, { paid: false });
    await makeOverdue(order.id);
    await runDeadlineWorkerOnce();

    const res = await request(app)
      .post(`/api/v1/orders/${order.id}/pay`)
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ idempotencyKey: 'late' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_NOT_PAYABLE');
  });

  it('does not resurrect a cancelled order when a late payment webhook succeeds', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const order = await createOrder(seller.accessToken, buyer.accessToken, { paid: false });
    await prisma.payment.create({
      data: { orderId: order.id, provider: paymentProvider.name, providerRef: `late-${order.id}`, amountCents: order.amountCents, idempotencyKey: 'k2', status: 'PENDING' },
    });
    await prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED', cancelReason: 'PAYMENT_TIMEOUT', cancelledAt: new Date() } });

    const result = await applyPaymentWebhookEvent(paymentProvider.name, `late-${order.id}`, 'SUCCEEDED');

    expect(result.applied).toBe(true);
    expect((await fresh(order.id)).status).toBe('CANCELLED');
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
    expect(payment.status).toBe('SUCCEEDED'); // the money really moved; the record must say so
    expect(await orderEvents(order.id, 'payment.succeeded')).toHaveLength(0);
  });
});
