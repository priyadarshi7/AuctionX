import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { handleNotificationEvent } from '../../src/modules/notifications/consumer';

const app = createApp();

const runId = Date.now();
let counter = 0;
const testEmails: string[] = [];
const createdUserIds: string[] = [];

function uniqueEmail(label: string): string {
  counter += 1;
  const email = `test-notif-consumer-${runId}-${counter}-${label}@example.com`.toLowerCase();
  testEmails.push(email);
  return email;
}

async function registerAndLogin(label = 'user') {
  const email = uniqueEmail(label);
  const password = 'correct-horse-battery';
  await request(app).post('/api/v1/auth/register').send({ email, password, name: 'Consumer Test' });
  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
  const userId = loginRes.body.user.id as string;
  createdUserIds.push(userId);
  return userId;
}

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.refreshToken.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  await prisma.$disconnect();
});

// Calls handleNotificationEvent directly — this is the exact function
// modules/notifications/consumer.ts's runConsumer wires up as its
// eachMessage handler, so testing it this way exercises the real mapping/
// idempotency logic without needing a real subscribed consumer to wait on
// real message delivery (that full pipeline is covered separately in
// notifications/notifications.test.ts). Redelivery — Kafka's at-least-once
// guarantee (Section 15) — is specifically what these tests exist to
// prove is handled correctly, which the end-to-end test never exercises
// (it only ever sees a message once).
describe('modules/notifications/consumer — handleNotificationEvent', () => {
  it('is idempotent: processing the identical message twice creates only one notification', async () => {
    const userId = await registerAndLogin('outbid');
    const messageId = `bid-events:0:${randomUUID()}`;
    const payload = {
      type: 'bid.outbid' as const,
      auctionId: randomUUID(),
      outbidUserId: userId,
      previousAmountCents: 1000,
      newAmountCents: 1500,
    };

    await handleNotificationEvent('bid-events', null, payload, messageId);
    await handleNotificationEvent('bid-events', null, payload, messageId);

    const notifications = await prisma.notification.findMany({ where: { sourceEventId: messageId } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.userId).toBe(userId);
  });

  it('a single auction.sold message produces two notifications (buyer + seller), stable under redelivery', async () => {
    const buyerId = await registerAndLogin('buyer');
    const sellerId = await registerAndLogin('seller');
    const messageId = `auction-events:0:${randomUUID()}`;
    const payload = {
      type: 'auction.sold' as const,
      auctionId: randomUUID(),
      orderId: randomUUID(),
      buyerId,
      sellerId,
      amountCents: 5000,
    };

    await handleNotificationEvent('auction-events', null, payload, messageId);
    // Redeliver — must not duplicate either side.
    await handleNotificationEvent('auction-events', null, payload, messageId);

    const notifications = await prisma.notification.findMany({ where: { sourceEventId: messageId } });
    expect(notifications).toHaveLength(2);
    const types = notifications.map((n) => n.type).sort();
    expect(types).toEqual(['AUCTION_SOLD', 'AUCTION_WON']);
  });

  it('throws on an unrecognized payload shape (the signal runConsumer uses to route a message to its DLQ)', async () => {
    await expect(
      handleNotificationEvent('bid-events', null, { type: 'not.a.real.event' }, 'bid-events:0:garbage'),
    ).rejects.toThrow();

    await expect(handleNotificationEvent('bid-events', null, null, 'bid-events:0:null-payload')).rejects.toThrow();
  });
});
