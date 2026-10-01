# 0034 — Stale WSL2 relays hang requests forever; forced IPv4 + a Redis command timeout

## Context

ADR-0028 already documented one failure mode of WSL2's automatic
localhost-forwarding (`wslrelay.exe`): two services colliding on the same
port. This is a different failure mode of the same underlying mechanism,
hit twice in one session after the dev servers were stopped and restarted
several times:

1. `/readiness` (a plain `SELECT 1` against Postgres) started returning 503
   "unavailable" with Postgres itself fully healthy (`docker ps`,
   `pg_isready` both green). A raw Prisma `$queryRaw` against
   `localhost:5432` failed fast with "Can't reach database server"; the
   identical query against `127.0.0.1:5432` succeeded instantly.
2. Later, with the DB fix already in place, the frontend got stuck on
   "Checking session" forever. `/readiness` was fine (still 200), but
   `POST /api/v1/auth/refresh` and `/auth/login` — both behind
   `middleware/rateLimit.ts`'s Redis-backed limiter — hung indefinitely.
   `docker exec auctionx-redis redis-cli ping` returned `PONG` immediately;
   a raw `ioredis` connection to `redis://localhost:6380` hung past 5
   seconds with zero bytes received, while the identical connection to
   `127.0.0.1:6380` replied instantly.

## Problem

`netstat` showed, for every affected port, TWO listeners: Docker's real
forwarder bound to the wildcard address (`0.0.0.0:PORT`), and a SEPARATE
`wslrelay.exe` listener bound only to `[::1]:PORT`. `localhost` on this
machine resolves to `::1` first, so every connection attempt went to the
`wslrelay.exe` listener, not Docker's. Unlike ADR-0028's collision (where
the `::1` listener belonged to a different, live service), these `::1`
listeners were stale forwarding table entries left over from the
container/network churn earlier in the session — the TCP handshake
completed instantly (the OS-level listener accepted it), but no protocol
bytes ever flowed through to the actual container behind it.

This is the exact "TCP connects, no protocol data flows" failure mode
already diagnosed once before against Docker Desktop's own network bridge
earlier in this project's history — same symptom, different layer
(`wslrelay.exe`'s stale forwarding table, not Docker Desktop's bridge
itself).

**The two incidents exposed different underlying bugs, not just two
instances of the same one:**

- Postgres: Prisma's query engine has its own internal connect timeout and
  failed fast on its own — no code change needed, `127.0.0.1` alone fixed it.
- Redis: `infrastructure/redis/client.ts` configured `maxRetriesPerRequest`
  but no `commandTimeout`. ioredis's `connectTimeout` only bounds the TCP
  handshake — which a stale relay satisfies instantly — so a command sent
  over an already-"connected" dead socket waits forever for a reply that
  will never come. `middleware/rateLimit.ts`'s `try { await redis.eval(...)
  } catch { failOpen() }` is correctly written, but a promise that never
  settles never reaches either branch — so the already-built fail-open
  design never got the chance to run.

## Decision

Two changes, addressing the immediate instance and the recurring class of
bug separately:

1. **`services/api/.env` and `.env.example`**: every internally-initiated
   connection URL (`DATABASE_URL`, `REDIS_URL`, `KAFKA_BROKERS`,
   `OPENSEARCH_URL`, `OLLAMA_URL`) now uses `127.0.0.1` instead of
   `localhost`. `DATABASE_URL`/`REDIS_URL` were fixed because they were
   actually observed broken; `KAFKA_BROKERS`/`OPENSEARCH_URL`/`OLLAMA_URL`
   were changed preemptively — same mechanism, same machine, just not yet
   observed stale on those specific ports. `FRONTEND_URL` was deliberately
   NOT changed: it's not a connection this server initiates, it's a link
   baked into emails for the user's own browser to open, where `localhost`
   is exactly correct.
2. **`infrastructure/redis/client.ts`**: added `commandTimeout: 3000`. This
   is the actual durable fix — it bounds every Redis command's wait for a
   reply, so a dead-but-"connected" socket (from a stale relay, or ANY
   other cause — actual Redis unresponsiveness, a real network partition,
   anything) now rejects within 3 seconds and correctly falls into
   `rateLimit.ts`'s existing fail-open `catch`, instead of hanging the
   request forever.

## Why

The `.env` fix alone would only have patched today's specific stale
entries — the next time a container restarts and `wslrelay.exe` leaves
behind another stale `::1` forward (on these ports or a new one), the
exact same multi-step diagnosis would be needed again. The `commandTimeout`
fix is what actually closes the gap per Section 67 ("every network call
should have an appropriate timeout"): it makes Redis unavailability — of
any cause, not just this one — degrade in 3 seconds the way the fail-open
design always intended, rather than hanging indefinitely.

Prisma was deliberately left unchanged: it already demonstrated fail-fast
behavior against the identical stale-relay condition without any
configuration from this project, so there's no gap to close there (Section
82 — don't fix what isn't broken).

## Tradeoffs

```text
+ Any future Redis hang (WSL relay staleness again, a real Redis outage,
  network blip) now fails open in ~3s instead of hanging every
  /api/v1/auth/* request forever — including the frontend's silent
  session-refresh on every page load, which is what made this user-visible
  as a permanently stuck "Checking session".
+ 127.0.0.1 is strictly equivalent to or safer than localhost on every
  platform (Windows, WSL2, Linux, macOS, CI) — zero behavior change for
  anyone NOT hitting this specific WSL2 quirk.
- 3s is a real, user-facing delay on the specific unlucky request that
  catches a dead connection before ioredis's background reconnect logic
  notices and recovers — acceptable since it replaces "hangs forever" with
  "slow once," not "hangs forever" with "instant," and this client is only
  used for rate limiting and a read-through cache (Section 12), never
  anything load-bearing.
- This is a Windows/WSL2-specific workaround baked into a committed
  `.env.example` template — documented here and inline so a future reader
  on a different platform isn't confused by `127.0.0.1` where `localhost`
  would have worked identically for them too.
- Doesn't fix the root cause (wslrelay.exe's forwarding table itself going
  stale) — only makes every layer of this project resilient to it. A full
  `wsl --shutdown` would clear the actual stale entries but is disruptive
  (briefly stops every container) and wouldn't prevent recurrence, so it
  wasn't pursued as "the" fix, only noted as available if this ever needs
  a clean slate.
```

## Consequences

- `services/api/.env` (gitignored, this machine only) and
  `services/api/.env.example` (committed, the template for anyone else
  setting this project up) both updated.
- `infrastructure/redis/client.ts` gained one config field; no call site
  anywhere in `modules/` changed, since `rateLimit.ts`'s own error handling
  was already correct and just needed the promise to actually settle.
- Re-ran `tests/rateLimit.test.ts` (the suite that already exercises
  fail-open behavior via a mocked rejection) after this change — still
  green, confirming `commandTimeout` doesn't interfere with the existing
  fail-open test's own mock-based simulation.

## Revisit Conditions

- If Prisma is ever observed hanging (not just failing fast) against a
  similarly dead-but-connected socket, give it the same treatment
  (`PrismaClient`'s connection string supports `connect_timeout`/
  `pool_timeout` params) — not done now because it wasn't needed now.
- If this WSL2 relay-staleness behavior is ever confirmed fixed upstream
  (Docker Desktop or WSL2 itself), none of this needs reverting — `127.0.0.1`
  and a bounded command timeout are correct regardless, just mirrors
  ADR-0028's own "not worth reverting speculatively" stance.
- If a genuinely slow (not dead) Redis call ever legitimately needs more
  than 3s, raise `commandTimeout` rather than removing it — the problem
  being solved here is "hangs forever," not "take some bounded time."
