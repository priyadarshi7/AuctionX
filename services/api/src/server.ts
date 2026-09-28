import 'dotenv/config';
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './infrastructure/observability/logger';
import { prisma } from './infrastructure/database/prisma';
import { redis } from './infrastructure/redis/client';
import { startAuctionClosingWorker, stopAuctionClosingWorker } from './infrastructure/jobs/auctionClosingWorker';
import { startWebSocketGateway, stopWebSocketGateway } from './infrastructure/websocket/gateway';
import { ensureBucketExists } from './infrastructure/storage/s3Client';

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

// Graceful shutdown: stop accepting new connections, let in-flight requests
// finish, close the DB pool and Redis connection, then exit. Once Kafka
// exists, it must be closed here too, in dependency order (Section 69) — the
// HTTP server closes first because nothing should still be trying to use
// Prisma/Redis after that. Redis closing cleanly isn't safety-critical the
// way Prisma's is (Section 12 — nothing here is the source of truth), but
// leaving the connection open would leak a handle and could delay process
// exit. WebSockets close BEFORE the HTTP server, not after: open WS
// connections aren't in-flight HTTP requests that need to finish, they're
// long-lived, so there's no reason to wait — every client gets a clean
// "going away" frame telling it to reconnect, rather than the connection
// just dying when the process exits.
function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutting down gracefully');
  stopAuctionClosingWorker();
  stopWebSocketGateway();
  server.close((err) => {
    if (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
    void Promise.allSettled([prisma.$disconnect(), redis.quit()])
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
