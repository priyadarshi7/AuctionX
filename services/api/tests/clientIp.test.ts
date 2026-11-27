import express from 'express';
import request from 'supertest';
import { createApp } from '../src/app';
import { TRUSTED_PROXIES } from '../src/config/trustedProxies';
import { errorHandler } from '../src/middleware/errors';
import { rateLimit } from '../src/middleware/rateLimit';

// Supertest connects over loopback, which stands in for the host's own proxy.
const runId = Date.now();
// The two proxy hops a request passes through in production: Cloudflare, then
// the host's private network.
const PROXIES = '172.68.10.20, 10.20.30.40';

function probeApp(keyPrefix: string, max = 1) {
  const app = express();
  app.set('trust proxy', TRUSTED_PROXIES);
  app.use(rateLimit({ windowSeconds: 60, max, keyPrefix: `${keyPrefix}-${runId}` }));
  app.get('/ip', (req, res) => {
    res.json({ ip: req.ip });
  });
  app.use(errorHandler);
  return app;
}

describe('client IP behind proxies (ADR-0047)', () => {
  it('is configured on the real app', () => {
    expect(createApp().get('trust proxy')).toBe(TRUSTED_PROXIES);
  });

  it.each([
    ['through Cloudflare and the host', `203.0.113.7, ${PROXIES}`, '203.0.113.7'],
    ['through one private proxy', '203.0.113.7, 10.20.30.40', '203.0.113.7'],
    ['through a carrier-grade NAT hop', '203.0.113.7, 100.64.0.9', '203.0.113.7'],
    ['over IPv6', '2001:db8::7, 2606:4700::1111, 10.20.30.40', '2001:db8::7'],
  ])('finds the client %s', async (_name, forwardedFor, expected) => {
    const res = await request(probeApp(`find-${expected}-${forwardedFor.length}`))
      .get('/ip')
      .set('X-Forwarded-For', forwardedFor);

    expect(res.body.ip).toBe(expected);
  });

  it('gives visitors behind the same proxies separate budgets', async () => {
    const app = probeApp('separate');
    const as = (client: string) => request(app).get('/ip').set('X-Forwarded-For', `${client}, ${PROXIES}`);

    expect((await as('203.0.113.1')).status).toBe(200);
    expect((await as('203.0.113.1')).status).toBe(429);
    expect((await as('203.0.113.2')).status).toBe(200);
  });

  it('ignores addresses a client invents, so the limit cannot be dodged', async () => {
    const app = probeApp('spoof');
    // The proxies append the real address to whatever the client sent.
    const forged = (fake: string) =>
      request(app).get('/ip').set('X-Forwarded-For', `${fake}, 203.0.113.9, ${PROXIES}`);

    const first = await forged('1.1.1.1');
    expect(first.body.ip).toBe('203.0.113.9');
    expect((await forged('2.2.2.2')).status).toBe(429);
  });
});
