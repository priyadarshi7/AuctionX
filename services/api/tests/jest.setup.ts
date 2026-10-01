import { redis } from '../src/infrastructure/redis/client';

// Each test FILE gets its own Jest module registry, so each one creates its
// own ioredis connection — this teardown runs once per file, not once
// globally. Without it, the open connection keeps Jest's process alive
// after tests finish (no error, just a hang).
//
// Deliberately NOT also disconnecting Prisma here: setupFilesAfterEnv hooks
// register before a test file's own top-level afterAll, so a shared
// prisma.$disconnect() here could run before a test file's own DB cleanup
// (e.g. deleteMany) — which would then fail against an already-closed
// connection. Redis has no such ordering dependency, so it's safe to
// centralize; Prisma disconnect stays each file's own responsibility,
// sequenced explicitly after its own cleanup.
afterAll(async () => {
  // redis.quit() waits for a live connection to send QUIT on — if the
  // client is mid-reconnect (client.ts sets no retryStrategy/
  // connectTimeout, so a connection hiccup at test startup means ioredis's
  // default unbounded backoff loop), quit() never resolves and the whole
  // test run hangs silently with no error, no timeout, nothing (confirmed
  // live 2026-09-30: 23+ minutes, zero CPU, no output). Racing it against a
  // short timeout and force-disconnecting either way guarantees teardown
  // actually finishes — this only affects test teardown, not the
  // production client's intentionally-unbounded reconnect behavior.
  await Promise.race([redis.quit(), new Promise((resolve) => setTimeout(resolve, 3000))]);
  redis.disconnect();
});
