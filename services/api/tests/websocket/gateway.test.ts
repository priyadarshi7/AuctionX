import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  broadcastToAuction,
  startWebSocketGateway,
  stopWebSocketGateway,
} from '../../src/infrastructure/websocket/gateway';
import { signAccessToken } from '../../src/infrastructure/security/tokens';

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected server.address() to return an AddressInfo');
  }
  port = address.port;
});

afterAll(async () => {
  stopWebSocketGateway();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

// Every test calls this with its own (usually short) timeouts, and each test
// tears the gateway down afterward — proving start/stop is actually
// symmetric (no leaked `upgrade` listener across tests), not just something
// that happens to work once per process lifetime the way it does in
// server.ts's real boot/shutdown.
afterEach(() => {
  stopWebSocketGateway();
});

function wsUrl(): string {
  return `ws://127.0.0.1:${String(port)}/ws`;
}

function validToken(): string {
  return signAccessToken({ sub: randomUUID(), role: 'USER' });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once('message', (data: Buffer) => {
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });
}

function nextClose(ws: WebSocket): Promise<{ code: number }> {
  return new Promise((resolve) => {
    ws.once('close', (code: number) => resolve({ code }));
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => ws.once('open', () => resolve()));
}

describe('WebSocket gateway', () => {
  it('closes a connection that presents an invalid token', async () => {
    startWebSocketGateway(server);
    const ws = new WebSocket(wsUrl());
    await waitForOpen(ws);

    ws.send(JSON.stringify({ type: 'auth', accessToken: 'not-a-real-token' }));
    const { code } = await nextClose(ws);
    expect(code).toBe(4002);
  });

  it('accepts a connection presenting a valid access token', async () => {
    startWebSocketGateway(server);
    const ws = new WebSocket(wsUrl());
    await waitForOpen(ws);

    ws.send(JSON.stringify({ type: 'auth', accessToken: validToken() }));
    const ack = await nextMessage(ws);
    expect(ack).toEqual({ type: 'auth.ok' });

    ws.close();
  });

  // ADR-0021: auth is optional, not a precondition for subscribing — an
  // anonymous visitor watching a public auction (ADR-0008) has no access
  // token to send at all, and this channel carries no privileged data, so
  // there is nothing for a mandatory-auth gate to protect.
  it('allows subscribe/unsubscribe without ever authenticating', async () => {
    startWebSocketGateway(server);
    const auctionId = randomUUID();
    const ws = new WebSocket(wsUrl());
    await waitForOpen(ws);

    ws.send(JSON.stringify({ type: 'subscribe', auctionId }));
    const subscribed = await nextMessage(ws);
    expect(subscribed).toEqual({ type: 'subscribed', auctionId });

    const received = nextMessage(ws);
    broadcastToAuction(auctionId, { type: 'auction.changed', auctionId, reason: 'bid' });
    await expect(received).resolves.toEqual({ type: 'auction.changed', auctionId, reason: 'bid' });

    ws.send(JSON.stringify({ type: 'unsubscribe', auctionId }));
    const unsubscribed = await nextMessage(ws);
    expect(unsubscribed).toEqual({ type: 'unsubscribed', auctionId });

    ws.close();
  });

  it('delivers a broadcast only to sockets subscribed to that auction', async () => {
    startWebSocketGateway(server);
    const auctionA = randomUUID();
    const auctionB = randomUUID();

    const subscriberA = new WebSocket(wsUrl());
    const subscriberB = new WebSocket(wsUrl());
    await Promise.all([waitForOpen(subscriberA), waitForOpen(subscriberB)]);

    subscriberA.send(JSON.stringify({ type: 'auth', accessToken: validToken() }));
    await nextMessage(subscriberA); // auth.ok
    subscriberA.send(JSON.stringify({ type: 'subscribe', auctionId: auctionA }));
    await nextMessage(subscriberA); // subscribed

    subscriberB.send(JSON.stringify({ type: 'auth', accessToken: validToken() }));
    await nextMessage(subscriberB); // auth.ok
    subscriberB.send(JSON.stringify({ type: 'subscribe', auctionId: auctionB }));
    await nextMessage(subscriberB); // subscribed

    const receivedByA = nextMessage(subscriberA);
    const receivedByBTimeout = Promise.race([
      nextMessage(subscriberB).then(() => 'message'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 200)),
    ]);

    broadcastToAuction(auctionA, { type: 'bid.accepted', auctionId: auctionA, amountCents: 5000 });

    await expect(receivedByA).resolves.toEqual({
      type: 'bid.accepted',
      auctionId: auctionA,
      amountCents: 5000,
    });
    // Subscriber B never subscribed to auction A's room, so it must not
    // receive this broadcast — proving fanout is scoped per auction, not
    // sent to every connected socket.
    await expect(receivedByBTimeout).resolves.toBe('timeout');

    subscriberA.close();
    subscriberB.close();
  });

  it('stops delivering broadcasts to a socket after it unsubscribes', async () => {
    startWebSocketGateway(server);
    const auctionId = randomUUID();
    const ws = new WebSocket(wsUrl());
    await waitForOpen(ws);

    ws.send(JSON.stringify({ type: 'auth', accessToken: validToken() }));
    await nextMessage(ws); // auth.ok
    ws.send(JSON.stringify({ type: 'subscribe', auctionId }));
    await nextMessage(ws); // subscribed
    ws.send(JSON.stringify({ type: 'unsubscribe', auctionId }));
    await nextMessage(ws); // unsubscribed

    const receivedTimeout = Promise.race([
      nextMessage(ws).then(() => 'message'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 200)),
    ]);
    broadcastToAuction(auctionId, { type: 'bid.accepted', auctionId, amountCents: 5000 });

    await expect(receivedTimeout).resolves.toBe('timeout');
    ws.close();
  });

  it('a socket that keeps responding to pings survives across a heartbeat interval', async () => {
    // The `ws` client library answers `ping` frames with `pong` frames
    // automatically at the protocol level — no application code on the
    // client side is involved. This test's real purpose is to prove OUR
    // wiring doesn't mistakenly terminate a healthy connection, not to
    // test `ws` itself.
    startWebSocketGateway(server, { heartbeatIntervalMs: 100 });
    const ws = new WebSocket(wsUrl());
    await waitForOpen(ws);
    ws.send(JSON.stringify({ type: 'auth', accessToken: validToken() }));
    await nextMessage(ws); // auth.ok

    await new Promise((resolve) => setTimeout(resolve, 250)); // >2 heartbeat intervals
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('closes every open connection with code 1001 when the gateway stops', async () => {
    startWebSocketGateway(server);
    const ws = new WebSocket(wsUrl());
    await waitForOpen(ws);
    ws.send(JSON.stringify({ type: 'auth', accessToken: validToken() }));
    await nextMessage(ws); // auth.ok

    const closed = nextClose(ws);
    stopWebSocketGateway();

    const { code } = await closed;
    expect(code).toBe(1001);
  });
});
