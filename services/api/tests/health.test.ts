import request from 'supertest';
import { createApp } from '../src/app';
import { prisma } from '../src/infrastructure/database/prisma';

describe('health endpoints', () => {
  const app = createApp();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('GET /liveness returns 200 ok', async () => {
    const res = await request(app).get('/liveness');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /readiness returns 200 ok', async () => {
    const res = await request(app).get('/readiness');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('returns a structured 404 for unknown routes', async () => {
    const res = await request(app).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(res.body.error.requestId).toBeDefined();
  });

  it('echoes a client-supplied x-request-id header', async () => {
    const res = await request(app).get('/liveness').set('x-request-id', 'test-req-123');
    expect(res.headers['x-request-id']).toBe('test-req-123');
  });
});
