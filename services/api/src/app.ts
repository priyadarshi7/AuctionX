import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import { errorHandler, notFoundHandler } from './middleware/errors';
import { optionalAuthenticate } from './middleware/authenticate';
import { apiRateLimit } from './middleware/rateLimit';
import { env } from './config/env';
import { logger } from './infrastructure/observability/logger';
import { prisma } from './infrastructure/database/prisma';
import { authRoutes } from './modules/auth/routes';
import { auctionRoutes } from './modules/auctions/routes';
import { bidRoutes } from './modules/bids/routes';
import { uploadRoutes } from './modules/uploads/routes';
import { orderRoutes } from './modules/orders/routes';
import { paymentWebhookRoutes } from './modules/payments/routes';
import { notificationRoutes } from './modules/notifications/routes';

export function createApp(): Express {
  const app = express();

  app.use(helmet());
  // A real frontend origin exists now (apps/web) — this closes the gap
  // flagged since AUTH-003: a single known origin, credentials enabled, so
  // the browser will actually send/accept the httpOnly refresh cookie
  // cross-origin (localhost:3000 -> localhost:4000 in dev). Wildcard origin
  // + credentials is not a browser-allowed combination anyway, which is
  // exactly why this couldn't be configured before a real origin existed.
  app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
  // Mounted BEFORE express.json(): webhook signature verification needs the
  // EXACT bytes the provider signed (Section 28) — this router applies its
  // own express.raw() (modules/payments/routes.ts). If this were mounted
  // after express.json(), the body would already be a parsed-then-
  // theoretically-re-serialized object by the time it got here, which does
  // not reproduce the original signed bytes.
  app.use('/api/v1/webhooks/payments', paymentWebhookRoutes);
  app.use(express.json());
  app.use(cookieParser());
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const existing = req.headers['x-request-id'];
        const id = typeof existing === 'string' ? existing : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
    }),
  );

  // Liveness: "is the process alive?" — must not depend on DB/Redis/Kafka
  // (Section 70). A dependency outage should not make Kubernetes kill and
  // restart a perfectly healthy process.
  app.get('/liveness', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Readiness: "can this instance currently serve traffic?" Unlike
  // liveness, this DOES depend on the database — if Postgres is
  // unreachable, we want the load balancer to stop routing here, but we do
  // NOT want Kubernetes to kill and restart the process (that would not fix
  // a database outage and would just cause a restart loop).
  app.get('/readiness', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.status(200).json({ status: 'ok' });
    } catch (err) {
      logger.error({ err }, 'Readiness check failed: database unreachable');
      res.status(503).json({ status: 'unavailable' });
    }
  });

  // Not applied to /liveness or /readiness: those are hit by
  // orchestrators/load balancers, not attacker-facing surface, and rate
  // limiting them risks manufacturing a false "unhealthy" signal under load.
  app.use('/api/v1', optionalAuthenticate, apiRateLimit);
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/auctions', auctionRoutes);
  app.use('/api/v1/auctions/:auctionId/bids', bidRoutes);
  app.use('/api/v1/uploads', uploadRoutes);
  app.use('/api/v1/orders', orderRoutes);
  app.use('/api/v1/notifications', notificationRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
