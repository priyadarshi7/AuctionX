import 'dotenv/config';
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './infrastructure/observability/logger';
import { prisma } from './infrastructure/database/prisma';
import { redis } from './infrastructure/redis/client';
import { startAuctionClosingWorker, stopAuctionClosingWorker } from './infrastructure/jobs/auctionClosingWorker';
import {
  startOutboxPublisherWorker,
  stopOutboxPublisherWorker,
} from './infrastructure/jobs/outboxPublisherWorker';
import { startWebSocketGateway, stopWebSocketGateway } from './infrastructure/websocket/gateway';
import { ensureBucketExists } from './infrastructure/storage/s3Client';
import { connectProducer, disconnectProducer } from './infrastructure/kafka/producer';
import { startNotificationsConsumer, stopNotificationsConsumer } from './modules/notifications/consumer';
import { startSearchConsumer, stopSearchConsumer } from './modules/search/consumer';
import { ensureAuctionIndex } from './modules/search/repository';
import { reindexAllAuctions } from './modules/search/service';
import { startAiValuationConsumer, stopAiValuationConsumer } from './modules/ai/consumer';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API server listening');
});

startAuctionClosingWorker();
// Attached to the SAME http.Server app.listen() returned, not a second
// port — see gateway.ts's module comment for why this is one process today.
startWebSocketGateway(server);
// Fire-and-forget: never blocks the server from accepting traffic, and
// never throws (see its own doc comment) — image upload just isn't usable
// until this resolves, which is a fraction of a second against a healthy
// local s3mock/production R2 bucket that already exists.
void ensureBucketExists();
// Kafka/Redpanda wiring (ADR-0027): connecting the producer is
// fire-and-forget for the same reason as ensureBucketExists — the app must
// serve core traffic even if Redpanda is unreachable (Section 40).
// startOutboxPublisherWorker/startNotificationsConsumer are started
// unconditionally right after — the publisher's own runOnce checks
// isProducerConnected() before every scan, and the consumer's connect()
// retries internally (kafkajs's default retry config), so neither needs to
// wait on connectProducer() resolving first.
void connectProducer();
startOutboxPublisherWorker();
startNotificationsConsumer();
// Search (Phase 9, ADR-0029): same fire-and-forget/no-throw treatment as
// ensureBucketExists — the index bootstrap must never block boot, and
// startSearchConsumer's own connect() retries internally exactly like
// startNotificationsConsumer's does. When ensureAuctionIndex just CREATED
// the index (vs. found it already existing), a one-time full backfill
// runs right after — otherwise a fresh index (or a real, pre-existing
// auction nothing has mutated since search shipped, ADR-0031) has no
// reindex event to ever populate it from.
void ensureAuctionIndex()
  .then(({ created }) => {
    if (created) return reindexAllAuctions();
    return undefined;
  })
  .catch((err: unknown) => {
    logger.error({ err }, 'Failed to ensure OpenSearch auction index exists / backfill');
  });
startSearchConsumer();
// AI valuation (Phase 10, ADR-0032): same fire-and-forget treatment as the
// search consumer above — no bootstrap step needed here (unlike search's
// ensureAuctionIndex, there's no external index to create), just start
// consuming. Ollama being unreachable is handled per-event inside
// modules/ai/consumer.ts (a FAILED valuation, not a crashed process).
startAiValuationConsumer();

// Graceful shutdown: stop accepting new connections, let in-flight requests
// finish, close the DB pool and Redis connection, then exit (Section 69).
// The HTTP server closes first because nothing should still be trying to
// use Prisma/Redis after that. Redis closing cleanly isn't safety-critical
// the way Prisma's is (Section 12 — nothing here is the source of truth),
// but leaving the connection open would leak a handle and could delay
// process exit. WebSockets close BEFORE the HTTP server, not after: open WS
// connections aren't in-flight HTTP requests that need to finish, they're
// long-lived, so there's no reason to wait — every client gets a clean
// "going away" frame telling it to reconnect, rather than the connection
// just dying when the process exits.
//
// Kafka pieces stop in dependency order, before the HTTP server: the
// notifications consumer first (stop accepting new work), then the outbox
// publisher (stop producing new work onto a soon-to-be-closed producer),
// then the producer itself — the same "stop the thing that depends on X
// before closing X" discipline Prisma/Redis already follow below.
function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutting down gracefully');
  stopAuctionClosingWorker();
  stopOutboxPublisherWorker();
  stopWebSocketGateway();
  void stopNotificationsConsumer().catch((err: unknown) => {
    logger.error({ err }, 'Error stopping notifications consumer');
  });
  void stopSearchConsumer().catch((err: unknown) => {
    logger.error({ err }, 'Error stopping search consumer');
  });
  void stopAiValuationConsumer().catch((err: unknown) => {
    logger.error({ err }, 'Error stopping AI valuation consumer');
  });
  server.close((err) => {
    if (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
    void Promise.allSettled([prisma.$disconnect(), redis.quit(), disconnectProducer()])
      .then((results) => {
        for (const result of results) {
          if (result.status === 'rejected') {
            logger.error({ err: result.reason }, 'Error during shutdown cleanup');
          }
        }
      })
      .finally(() => process.exit(0));
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
