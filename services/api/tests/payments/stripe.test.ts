import request from 'supertest';
import Stripe from 'stripe';
import { createApp } from '../../src/app';
import { env } from '../../src/config/env';
import { prisma } from '../../src/infrastructure/database/prisma';
import { runOnce } from '../../src/infrastructure/jobs/auctionClosingWorker';
import { paymentProvider } from '../../src/infrastructure/payments';
import type { PaymentProvider } from '../../src/infrastructure/payments';
import { StripePaymentProvider } from '../../src/infrastructure/payments/stripeProvider';
import { hashPassword } from '../../src/infrastructure/security/password';

// The service-level tests below run against a controllable fake provider (no
// network, no Stripe account). The real StripePaymentProvider is tested
// separately, at the bottom, for what it can prove offline: webhook signature
// verification and the live-mode refusals.
jest.mock('../../src/infrastructure/payments', () => ({
  paymentProvider: {
    name: 'fake',
    signatureHeader: 'x-fake-signature',
    createPaymentIntent: jest.fn(),
    verifyWebhookEvent: jest.fn(),
    fetchStatus: jest.fn(),
    refund: jest.fn(),
  },
  mockPaymentProvider: { setWebhookHandler: jest.fn() },
}));

const fake = paymentProvider as jest.Mocked<PaymentProvider>;
const app = createApp();

const runId = Date.now();
let counter = 0;
const testEmails: string[] = [];
const createdAuctionIds: string[] = [];
const PASSWORD = 'correct-horse-battery';

function uniqueEmail(label: string): string {
  counter += 1;
  const email = `test-stripe-${runId}-${counter}-${label}@example.com`.toLowerCase();
  testEmails.push(email);
  return email;
}

async function registerAndLogin(label: string) {
  const email = uniqueEmail(label);
  await request(app).post('/api/v1/auth/register').send({ email, password: PASSWORD, name: 'Stripe Test' });
  await prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { accessToken: login.body.accessToken as string };
}

async function createAdmin() {
  const email = uniqueEmail('admin');
  await prisma.user.create({
    data: { email, passwordHash: await hashPassword(PASSWORD), name: 'Admin', role: 'ADMIN', emailVerifiedAt: new Date() },
  });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { accessToken: login.body.accessToken as string };
}

const as = (token: string) => ({ Authorization: `Bearer ${token}` });

async function createOrder(amountCents = 2000) {
  const seller = await registerAndLogin('seller');
  const buyer = await registerAndLogin('buyer');
  const created = await request(app)
    .post('/api/v1/auctions')
    .set(as(seller.accessToken))
    .send({ title: 'Stripe Lot', description: 'desc', category: 'OTHER', condition: 'GOOD', startingPriceCents: 1000 });
  const auctionId = created.body.auction.id as string;
  createdAuctionIds.push(auctionId);
  await request(app)
    .post(`/api/v1/auctions/${auctionId}/publish`)
    .set(as(seller.accessToken))
    .send({ endTime: new Date(Date.now() + 3_600_000).toISOString() });
  await request(app).post(`/api/v1/auctions/${auctionId}/start`).set(as(seller.accessToken));
  const bid = await request(app)
    .post(`/api/v1/auctions/${auctionId}/bids`)
    .set(as(buyer.accessToken))
    .send({ amountCents, idempotencyKey: `${auctionId}-${amountCents}` });
  expect(bid.status).toBe(201);
  await prisma.auction.update({ where: { id: auctionId }, data: { endTime: new Date(Date.now() - 1_000) } });
  await runOnce();
  const order = await prisma.order.findUniqueOrThrow({ where: { auctionId } });
  return { seller, buyer, order };
}

let sessionCounter = 0;
function nextSession(): string {
  sessionCounter += 1;
  return `cs_test_${runId}_${sessionCounter}`;
}

const pay = (token: string, orderId: string, key = `key-${Math.random()}`) =>
  request(app).post(`/api/v1/orders/${orderId}/pay`).set(as(token)).send({ idempotencyKey: key });

const webhook = () => request(app).post('/api/v1/webhooks/payments/stripe').set('x-fake-signature', 'x').send(Buffer.from('{}'));

beforeEach(() => {
  jest.resetAllMocks();
});

afterAll(async () => {
  await prisma.outboxEvent.deleteMany({ where: { key: { in: createdAuctionIds } } });
  const orders = await prisma.order.findMany({ where: { auctionId: { in: createdAuctionIds } }, select: { id: true } });
  const orderIds = orders.map((o) => o.id);
  await prisma.outboxEvent.deleteMany({ where: { key: { in: orderIds } } });
  await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: orderIds } } });
  await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { auctionId: { in: createdAuctionIds } } });
  await prisma.bid.deleteMany({ where: { auctionId: { in: createdAuctionIds } } });
  await prisma.auction.deleteMany({ where: { id: { in: createdAuctionIds } } });
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  await prisma.$disconnect();
});

describe('starting a payment', () => {
  it('returns the provider’s checkout URL and passes our amount and return URL to it', async () => {
    const { buyer, order } = await createOrder(2500);
    const ref = nextSession();
    fake.fetchStatus.mockResolvedValue({ state: 'open', checkoutUrl: null });
    fake.createPaymentIntent.mockResolvedValue({ providerRef: ref, status: 'PENDING', checkoutUrl: `https://stripe.test/${ref}` });

    const res = await pay(buyer.accessToken, order.id);
    expect(res.status).toBe(200);
    expect(res.body.checkoutUrl).toBe(`https://stripe.test/${ref}`);
    expect(res.body.payment).toMatchObject({ providerRef: ref, status: 'PENDING', amountCents: 2500 });
    expect(fake.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: order.id, amountCents: 2500, returnUrl: `${env.FRONTEND_URL}/orders/${order.id}` }),
    );
  });

  it('sends a returning buyer back to the SAME open checkout instead of starting a second one', async () => {
    const { buyer, order } = await createOrder();
    const ref = nextSession();
    fake.createPaymentIntent.mockResolvedValue({ providerRef: ref, status: 'PENDING', checkoutUrl: `https://stripe.test/${ref}` });
    await pay(buyer.accessToken, order.id);

    fake.fetchStatus.mockResolvedValue({ state: 'open', checkoutUrl: `https://stripe.test/${ref}` });
    const again = await pay(buyer.accessToken, order.id);
    expect(again.body.checkoutUrl).toBe(`https://stripe.test/${ref}`);
    expect(fake.createPaymentIntent).toHaveBeenCalledTimes(1);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('settles an expired attempt as FAILED and starts a fresh one, so the order is never wedged', async () => {
    const { buyer, order } = await createOrder();
    const first = nextSession();
    const second = nextSession();
    fake.createPaymentIntent
      .mockResolvedValueOnce({ providerRef: first, status: 'PENDING', checkoutUrl: `https://stripe.test/${first}` })
      .mockResolvedValueOnce({ providerRef: second, status: 'PENDING', checkoutUrl: `https://stripe.test/${second}` });
    await pay(buyer.accessToken, order.id);

    fake.fetchStatus.mockResolvedValue({ state: 'expired' });
    const retry = await pay(buyer.accessToken, order.id);
    expect(retry.body.checkoutUrl).toBe(`https://stripe.test/${second}`);
    expect((await prisma.payment.findFirstOrThrow({ where: { providerRef: first } })).status).toBe('FAILED');
  });
});

describe('webhooks', () => {
  it('marks the order PAID once, and a duplicate delivery changes nothing', async () => {
    const { buyer, order } = await createOrder(3000);
    const ref = nextSession();
    fake.fetchStatus.mockResolvedValue({ state: 'open', checkoutUrl: null });
    fake.createPaymentIntent.mockResolvedValue({ providerRef: ref, status: 'PENDING', checkoutUrl: 'https://stripe.test/x' });
    await pay(buyer.accessToken, order.id);

    fake.verifyWebhookEvent.mockReturnValue({ type: 'payment.succeeded', providerRef: ref, amountCents: 3000 });
    expect((await webhook()).status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PAID');
    expect((await webhook()).status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PAID');
    expect(await prisma.outboxEvent.count({ where: { key: order.id, topic: 'payment-events' } })).toBe(1);
  });

  it('does NOT mark an order paid when the provider collected a different amount', async () => {
    const { buyer, order } = await createOrder(3000);
    const ref = nextSession();
    fake.createPaymentIntent.mockResolvedValue({ providerRef: ref, status: 'PENDING', checkoutUrl: 'https://stripe.test/x' });
    await pay(buyer.accessToken, order.id);

    fake.verifyWebhookEvent.mockReturnValue({ type: 'payment.succeeded', providerRef: ref, amountCents: 1 });
    expect((await webhook()).status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PENDING_PAYMENT');
    expect((await prisma.payment.findFirstOrThrow({ where: { providerRef: ref } })).status).toBe('PENDING');
  });

  it('rejects an unverifiable webhook with 400 and acknowledges an event it chooses to ignore', async () => {
    fake.verifyWebhookEvent.mockImplementationOnce(() => {
      throw new Error('bad signature');
    });
    expect((await webhook()).status).toBe(400);

    fake.verifyWebhookEvent.mockReturnValueOnce(null);
    expect((await webhook()).status).toBe(200);
  });
});

describe('late payments and refunds', () => {
  async function latePayment(amountCents = 2000) {
    const { buyer, order } = await createOrder(amountCents);
    const ref = nextSession();
    fake.createPaymentIntent.mockResolvedValue({ providerRef: ref, status: 'PENDING', checkoutUrl: 'https://stripe.test/x' });
    await pay(buyer.accessToken, order.id);
    // The 48h deadline cancels the order while the payment is still in flight.
    await prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
    fake.verifyWebhookEvent.mockReturnValue({ type: 'payment.succeeded', providerRef: ref, amountCents });
    return { order, ref };
  }

  it('refunds automatically when money arrives for an order that was already cancelled', async () => {
    const { order, ref } = await latePayment();
    fake.refund.mockResolvedValue({ refundRef: 're_test_1' });
    expect((await webhook()).status).toBe(200);

    const payment = await prisma.payment.findFirstOrThrow({ where: { providerRef: ref } });
    expect(payment.status).toBe('SUCCEEDED');
    expect(payment.refundedAt).not.toBeNull();
    expect(payment.refundRef).toBe('re_test_1');
    expect(fake.refund).toHaveBeenCalledWith(ref, `refund-${payment.id}`);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCELLED');
  });

  it('leaves it flagged "needs refund" if the automatic refund fails, and an admin can retry it once', async () => {
    const { order, ref } = await latePayment();
    fake.refund.mockRejectedValueOnce(new Error('stripe down'));
    expect((await webhook()).status).toBe(200);
    const payment = await prisma.payment.findFirstOrThrow({ where: { providerRef: ref } });
    expect(payment.refundedAt).toBeNull();

    const admin = await createAdmin();
    const flagged = await request(app).get('/api/v1/admin/orders?needsRefund=true&limit=50').set(as(admin.accessToken));
    expect(flagged.body.orders.map((o: { id: string }) => o.id)).toContain(order.id);

    fake.refund.mockResolvedValue({ refundRef: 're_test_2' });
    const retry = await request(app).post(`/api/v1/admin/orders/${order.id}/refund`).set(as(admin.accessToken));
    expect(retry.status).toBe(200);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).refundRef).toBe('re_test_2');
    expect(await prisma.adminAuditLog.count({ where: { targetId: order.id, action: 'order.refund' } })).toBe(1);

    const again = await request(app).post(`/api/v1/admin/orders/${order.id}/refund`).set(as(admin.accessToken));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('NOTHING_TO_REFUND');
  });

  it('only admins can refund', async () => {
    const { buyer, order } = await createOrder();
    const res = await request(app).post(`/api/v1/admin/orders/${order.id}/refund`).set(as(buyer.accessToken));
    expect(res.status).toBe(403);
  });
});

describe('buyer-triggered payment sync (a webhook that is late or missing)', () => {
  it('settles a payment the provider says is paid, and only for the buyer', async () => {
    const { buyer, seller, order } = await createOrder(4000);
    const ref = nextSession();
    fake.createPaymentIntent.mockResolvedValue({ providerRef: ref, status: 'PENDING', checkoutUrl: 'https://stripe.test/x' });
    await pay(buyer.accessToken, order.id);

    fake.fetchStatus.mockResolvedValue({ state: 'paid', amountCents: 4000 });
    expect((await request(app).post(`/api/v1/orders/${order.id}/payment/sync`).set(as(seller.accessToken))).status).toBe(403);
    expect((await request(app).post(`/api/v1/orders/${order.id}/payment/sync`).set(as(buyer.accessToken))).status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PAID');
  });

  it('refuses to settle when the provider reports a different amount', async () => {
    const { buyer, order } = await createOrder(4000);
    const ref = nextSession();
    fake.createPaymentIntent.mockResolvedValue({ providerRef: ref, status: 'PENDING', checkoutUrl: 'https://stripe.test/x' });
    await pay(buyer.accessToken, order.id);

    fake.fetchStatus.mockResolvedValue({ state: 'paid', amountCents: 5 });
    await request(app).post(`/api/v1/orders/${order.id}/payment/sync`).set(as(buyer.accessToken));
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PENDING_PAYMENT');
  });
});

// ---- the real provider, offline ----
describe('StripePaymentProvider (offline: signatures and live-mode refusal)', () => {
  const SECRET = 'whsec_test_secret';
  const stripe = new Stripe('sk_test_dummy');
  const provider = new StripePaymentProvider('sk_test_dummy', SECRET, 'usd');

  function signed(event: object, secret = SECRET): { body: Buffer; header: string } {
    const payload = JSON.stringify(event);
    return { body: Buffer.from(payload), header: stripe.webhooks.generateTestHeaderString({ payload, secret }) };
  }
  const session = (overrides: object = {}) => ({
    id: 'cs_test_abc',
    object: 'checkout.session',
    payment_status: 'paid',
    amount_total: 1234,
    currency: 'usd',
    ...overrides,
  });
  const event = (type: string, object: object, livemode = false) => ({
    id: 'evt_1',
    object: 'event',
    type,
    livemode,
    data: { object },
  });

  it('accepts a correctly signed paid session and reports the collected amount', () => {
    const { body, header } = signed(event('checkout.session.completed', session()));
    expect(provider.verifyWebhookEvent(body, header)).toEqual({ type: 'payment.succeeded', providerRef: 'cs_test_abc', amountCents: 1234 });
  });

  it('maps an expired session to a failure, ignores unpaid and unrelated events', () => {
    const expired = signed(event('checkout.session.expired', session({ payment_status: 'unpaid' })));
    expect(provider.verifyWebhookEvent(expired.body, expired.header)).toEqual({ type: 'payment.failed', providerRef: 'cs_test_abc' });

    const unpaid = signed(event('checkout.session.completed', session({ payment_status: 'unpaid' })));
    expect(provider.verifyWebhookEvent(unpaid.body, unpaid.header)).toBeNull();

    const other = signed(event('customer.created', { id: 'cus_1', object: 'customer' }));
    expect(provider.verifyWebhookEvent(other.body, other.header)).toBeNull();
  });

  it('rejects a bad signature, a missing signature, a tampered body, and an unconfigured secret', () => {
    const good = signed(event('checkout.session.completed', session()));
    const wrongSecret = signed(event('checkout.session.completed', session()), 'whsec_other');
    expect(() => provider.verifyWebhookEvent(good.body, wrongSecret.header)).toThrow();
    expect(() => provider.verifyWebhookEvent(good.body, undefined)).toThrow();
    expect(() => provider.verifyWebhookEvent(Buffer.from(good.body.toString().replace('1234', '1')), good.header)).toThrow();
    expect(() => new StripePaymentProvider('sk_test_dummy', undefined, 'usd').verifyWebhookEvent(good.body, good.header)).toThrow();
  });

  it('refuses a LIVE-mode event even when it is correctly signed', () => {
    const live = signed(event('checkout.session.completed', session({ livemode: true }), true));
    expect(() => provider.verifyWebhookEvent(live.body, live.header)).toThrow(/live-mode/);
  });

  it('refuses a paid session in the wrong currency', () => {
    const eur = signed(event('checkout.session.completed', session({ currency: 'eur' })));
    expect(() => provider.verifyWebhookEvent(eur.body, eur.header)).toThrow(/currency/);
  });
});

describe('configuration refuses live Stripe keys', () => {
  function loadEnvWith(key: string): { exited: boolean } {
    const saved = { ...process.env };
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.STRIPE_SECRET_KEY = key;
    let exited = false;
    try {
      jest.isolateModules(() => {
        require('../../src/config/env');
      });
    } catch {
      exited = true;
    } finally {
      process.env = saved;
      exit.mockRestore();
      error.mockRestore();
    }
    return { exited };
  }

  it('refuses sk_live_ and rk_live_ keys, and anything else that is not a test key', () => {
    expect(loadEnvWith('sk_live_abc123').exited).toBe(true);
    expect(loadEnvWith('rk_live_abc123').exited).toBe(true);
    expect(loadEnvWith('whatever').exited).toBe(true);
  });

  it('accepts test keys', () => {
    expect(loadEnvWith('sk_test_abc123').exited).toBe(false);
    expect(loadEnvWith('rk_test_abc123').exited).toBe(false);
  });
});
