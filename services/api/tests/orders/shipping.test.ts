import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { runOnce as runClosingWorkerOnce } from '../../src/infrastructure/jobs/auctionClosingWorker';
import { runOnce as runDeadlineWorkerOnce } from '../../src/infrastructure/jobs/orderPaymentDeadlineWorker';
import { Prisma } from '@prisma/client';
import { runOnce as runAutoConfirmOnce } from '../../src/infrastructure/jobs/orderAutoConfirmWorker';
import { runOnce as runSimulatorOnce } from '../../src/infrastructure/jobs/shipmentSimulatorWorker';
import { TEST_ADDRESS } from '../helpers/address';
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
    order = await prisma.order.update({ where: { id: order.id }, data: { status: 'PAID', shippingAddress: TEST_ADDRESS } });
  }
  return order;
}

const ship = (orderId: string, token: string) =>
  request(app).post(`/api/v1/orders/${orderId}/ship`).set('Authorization', `Bearer ${token}`);

const confirmDelivery = (orderId: string, token: string, code: string) =>
  request(app)
    .post(`/api/v1/orders/${orderId}/confirm-delivery`)
    .set('Authorization', `Bearer ${token}`)
    .send({ code });

const getOrder = (orderId: string, token: string) =>
  request(app).get(`/api/v1/orders/${orderId}`).set('Authorization', `Bearer ${token}`);

const regenerate = (orderId: string, token: string) =>
  request(app).post(`/api/v1/orders/${orderId}/delivery-code/regenerate`).set('Authorization', `Bearer ${token}`);

const saveAddress = (orderId: string, token: string, body: Record<string, unknown> = TEST_ADDRESS) =>
  request(app).put(`/api/v1/orders/${orderId}/shipping-address`).set('Authorization', `Bearer ${token}`).send(body);

// The code the buyer would see on their order page.
async function buyerCode(orderId: string, buyerToken: string): Promise<string> {
  const res = await getOrder(orderId, buyerToken);
  return res.body.order.deliveryCode as string;
}

const wrongCode = (real: string) => (real === '000000' ? '000001' : '000000');

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

describe('shipping address', () => {
  it('lets only the buyer set it, validates it, and refuses once the order has shipped', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const order = await createOrder(seller.accessToken, buyer.accessToken, { paid: false });

    expect((await saveAddress(order.id, seller.accessToken)).status).toBe(403);
    const bad = await saveAddress(order.id, buyer.accessToken, { ...TEST_ADDRESS, country: 'India', phone: 'abc' });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.error.details)).toEqual(expect.arrayContaining(['country', 'phone']));
    expect((await saveAddress(order.id, buyer.accessToken, { ...TEST_ADDRESS, line1: 'bad\nline' })).status).toBe(400);

    const ok = await saveAddress(order.id, buyer.accessToken, { ...TEST_ADDRESS, country: 'in' });
    expect(ok.status).toBe(200);
    expect(ok.body.order.shippingAddress).toMatchObject({ city: 'Pune', country: 'IN' });

    await prisma.order.update({ where: { id: order.id }, data: { status: 'SHIPPED' } });
    const late = await saveAddress(order.id, buyer.accessToken);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('ORDER_ADDRESS_LOCKED');
  });

  it('is required before paying', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const order = await createOrder(seller.accessToken, buyer.accessToken, { paid: false });

    const res = await request(app)
      .post(`/api/v1/orders/${order.id}/pay`)
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ idempotencyKey: 'k1' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SHIPPING_ADDRESS_REQUIRED');

    await saveAddress(order.id, buyer.accessToken);
    expect(
      (await request(app).post(`/api/v1/orders/${order.id}/pay`).set('Authorization', `Bearer ${buyer.accessToken}`).send({ idempotencyKey: 'k2' })).status,
    ).toBe(200);
  });

  it('is visible to the buyer, to the seller only while a parcel is to be sent, and to nobody else', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const stranger = await registerAndLogin('stranger');
    const order = await createOrder(seller.accessToken, buyer.accessToken, { paid: false });
    await saveAddress(order.id, buyer.accessToken);

    // Before payment the seller gets no address.
    expect((await getOrder(order.id, seller.accessToken)).body.order.shippingAddress).toBeNull();
    expect((await getOrder(order.id, buyer.accessToken)).body.order.shippingAddress).not.toBeNull();

    await prisma.order.update({ where: { id: order.id }, data: { status: 'PAID' } });
    expect((await getOrder(order.id, seller.accessToken)).body.order.shippingAddress).toMatchObject({ postalCode: '411001' });
    expect((await getOrder(order.id, stranger.accessToken)).status).toBe(403);

    // Never in a list the seller sees before shipping is relevant, and never the private counters.
    const list = await request(app).get('/api/v1/orders').set('Authorization', `Bearer ${seller.accessToken}`);
    const row = list.body.orders.find((o: { id: string }) => o.id === order.id);
    expect(row).not.toHaveProperty('deliveryOtpVersion');
    expect(row).not.toHaveProperty('deliveryOtpAttempts');

    await prisma.order.update({ where: { id: order.id }, data: { status: 'DELIVERED' } });
    expect((await getOrder(order.id, seller.accessToken)).body.order.shippingAddress).toBeNull();
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

  it('rejects shipping an order that has not been paid, or that has no address', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const unpaid = await createOrder(seller.accessToken, buyer.accessToken, { paid: false });
    const res = await ship(unpaid.id, seller.accessToken);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_NOT_SHIPPABLE');

    const noAddress = await createOrder(seller.accessToken, buyer.accessToken, { paid: true });
    await prisma.order.update({ where: { id: noAddress.id }, data: { shippingAddress: Prisma.DbNull } });
    const missing = await ship(noAddress.id, seller.accessToken);
    expect(missing.status).toBe(409);
    expect(missing.body.error.code).toBe('SHIPPING_ADDRESS_REQUIRED');
  });

  it('assigns the carrier and tracking number itself, opens the timeline, and writes exactly one order.shipped event', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const order = await createOrder(seller.accessToken, buyer.accessToken, { paid: true });

    const res = await ship(order.id, seller.accessToken);
    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({ status: 'SHIPPED', carrier: expect.stringContaining('AuctionX Express') });
    expect(res.body.order.trackingNumber).toMatch(/^AX\d{12}$/);
    expect(res.body.order.shippedAt).toEqual(expect.any(String));
    expect(res.body.order.shipmentEvents.map((e: { type: string }) => e.type)).toEqual(['LABEL_CREATED']);

    const events = await orderEvents(order.id, 'order.shipped');
    expect(events).toHaveLength(1);
    expect(events[0]!.topic).toBe('payment-events');
    expect(events[0]!.payload).toMatchObject({
      orderId: order.id,
      buyerId: order.buyerId,
      sellerId: order.sellerId,
      trackingNumber: res.body.order.trackingNumber,
    });
  });

  it('treats a repeat as a success without a second event or a second tracking number', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const order = await createOrder(seller.accessToken, buyer.accessToken, { paid: true });

    const first = await ship(order.id, seller.accessToken);
    const again = await ship(order.id, seller.accessToken);
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(again.body.order.trackingNumber).toBe(first.body.order.trackingNumber);
    expect(await orderEvents(order.id, 'order.shipped')).toHaveLength(1);
    expect(await prisma.shipmentEvent.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('lets two simultaneous requests both succeed while shipping exactly once', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const order = await createOrder(seller.accessToken, buyer.accessToken, { paid: true });

    const [a, b] = await Promise.all([ship(order.id, seller.accessToken), ship(order.id, seller.accessToken)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await orderEvents(order.id, 'order.shipped')).toHaveLength(1);
  });
});

describe('tracking timeline', () => {
  it('advances to in transit and out for delivery on its own, once each, and never to delivered', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const order = await createOrder(seller.accessToken, buyer.accessToken, { paid: true });
    await ship(order.id, seller.accessToken);
    const types = async () =>
      (await getOrder(order.id, buyer.accessToken)).body.order.shipmentEvents.map((e: { type: string }) => e.type);

    const step = 1_000;
    await runSimulatorOnce(new Date(), step); // too early: nothing yet
    expect(await types()).toEqual(['LABEL_CREATED']);

    await runSimulatorOnce(new Date(Date.now() + step + 100), step);
    expect(await types()).toEqual(['LABEL_CREATED', 'IN_TRANSIT']);

    await runSimulatorOnce(new Date(Date.now() + 3 * step), step);
    await runSimulatorOnce(new Date(Date.now() + 4 * step), step); // repeated ticks add nothing
    expect(await types()).toEqual(['LABEL_CREATED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY']);

    await runSimulatorOnce(new Date(Date.now() + 99 * step), step);
    expect(await types()).not.toContain('DELIVERED');
  });
});

describe('POST /api/v1/orders/:id/confirm-delivery (the delivery code)', () => {
  async function shippedOrder() {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const order = await createOrder(seller.accessToken, buyer.accessToken, { paid: true });
    await ship(order.id, seller.accessToken);
    return { seller, buyer, order };
  }

  it('shows the code only to the buyer of a shipped order', async () => {
    const { seller, buyer, order } = await shippedOrder();
    const code = await buyerCode(order.id, buyer.accessToken);
    expect(code).toMatch(/^\d{6}$/);
    expect((await getOrder(order.id, seller.accessToken)).body.order.deliveryCode).toBeNull();
    expect(JSON.stringify((await getOrder(order.id, seller.accessToken)).body)).not.toContain(code);
    // Stable across visits.
    expect(await buyerCode(order.id, buyer.accessToken)).toBe(code);
  });

  it('is the only way to deliver: the buyer cannot, early requests are refused, and the seller needs the right code', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const order = await createOrder(seller.accessToken, buyer.accessToken, { paid: true });

    const early = await confirmDelivery(order.id, seller.accessToken, '123456');
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('ORDER_NOT_DELIVERABLE');

    await ship(order.id, seller.accessToken);
    const code = await buyerCode(order.id, buyer.accessToken);
    expect((await confirmDelivery(order.id, buyer.accessToken, code)).status).toBe(403);
    expect((await confirmDelivery(order.id, seller.accessToken, 'abc')).status).toBe(400);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('SHIPPED');
  });

  it('delivers with the right code, once, with a DELIVERED tracking event and both parties notified', async () => {
    const { seller, buyer, order } = await shippedOrder();
    const code = await buyerCode(order.id, buyer.accessToken);

    const res = await confirmDelivery(order.id, seller.accessToken, code);
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('DELIVERED');
    expect(res.body.order.deliveredVia).toBe('OTP');
    expect(res.body.order.shipmentEvents.map((e: { type: string }) => e.type)).toContain('DELIVERED');

    expect((await confirmDelivery(order.id, seller.accessToken, code)).status).toBe(200);
    const events = await orderEvents(order.id, 'order.delivered');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ orderId: order.id, method: 'OTP' });
  });

  it('counts wrong guesses, locks after five, and only the buyer can unlock it with a new code', async () => {
    const { seller, buyer, order } = await shippedOrder();
    const code = await buyerCode(order.id, buyer.accessToken);

    for (let left = 4; left >= 0; left -= 1) {
      const res = await confirmDelivery(order.id, seller.accessToken, wrongCode(code));
      expect(res.status).toBe(400);
      expect(res.body.error.details.code[0]).toContain(`${left} ${left === 1 ? 'try' : 'tries'} left`);
    }
    // Even the RIGHT code is refused once locked.
    const locked = await confirmDelivery(order.id, seller.accessToken, code);
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('DELIVERY_CODE_LOCKED');
    expect((await getOrder(order.id, buyer.accessToken)).body.order.deliveryCodeLocked).toBe(true);
    expect((await regenerate(order.id, seller.accessToken)).status).toBe(403);

    const fresh = await regenerate(order.id, buyer.accessToken);
    expect(fresh.status).toBe(200);
    expect(fresh.body.order.deliveryCode).not.toBe(code);
    expect(fresh.body.order.deliveryCodeLocked).toBe(false);

    // The old code no longer works; the new one does.
    expect((await confirmDelivery(order.id, seller.accessToken, code)).status).toBe(400);
    expect((await confirmDelivery(order.id, seller.accessToken, fresh.body.order.deliveryCode)).status).toBe(200);
  });

  it('cannot be raced past the attempt limit by simultaneous guesses', async () => {
    const { seller, buyer, order } = await shippedOrder();
    const code = await buyerCode(order.id, buyer.accessToken);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => confirmDelivery(order.id, seller.accessToken, wrongCode(code))),
    );
    expect(results.filter((r) => r.status === 400)).toHaveLength(5);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).deliveryOtpAttempts).toBe(5);
  });

  it('refuses a code regeneration unless the order is shipped', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const order = await createOrder(seller.accessToken, buyer.accessToken, { paid: true });
    const res = await regenerate(order.id, buyer.accessToken);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_NOT_SHIPPED');
  });
});

describe('auto-confirming a delivery nobody completed', () => {
  it('delivers an order that has been shipped longer than the window, once, and leaves recent ones alone', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    const old = await createOrder(seller.accessToken, buyer.accessToken, { paid: true });
    const recent = await createOrder(seller.accessToken, buyer.accessToken, { paid: true });
    await ship(old.id, seller.accessToken);
    await ship(recent.id, seller.accessToken);
    await prisma.order.update({ where: { id: old.id }, data: { shippedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) } });

    await runAutoConfirmOnce();
    await runAutoConfirmOnce(); // a second pass is a no-op

    const after = await prisma.order.findUniqueOrThrow({ where: { id: old.id } });
    expect(after).toMatchObject({ status: 'DELIVERED', deliveredVia: 'AUTO' });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: recent.id } })).status).toBe('SHIPPED');
    const events = await orderEvents(old.id, 'order.delivered');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ method: 'AUTO' });
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
