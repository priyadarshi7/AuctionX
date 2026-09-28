# 0028 — Moving Redis off port 6379: a WSL2/Docker Desktop host-port collision

## Context

ADR-0021 flagged, but explicitly deferred, a finding from its own live
verification: `docker exec auctionx-redis redis-cli DBSIZE` showed an
empty container, but the API's own `REDIS_URL=redis://localhost:6379`
connection was reaching a different, persistent Redis holding 67 unrelated
keys (`bull:resourcex-jobs:*` — an unrelated project's BullMQ data). It was
left uninvestigated then because it didn't block that task.

It became directly blocking this session: raising `AUTH_RATE_LIMIT_MAX` for
local manual testing (a real, immediate need) couldn't be verified against
the actual Docker Redis — every `docker exec auctionx-redis redis-cli`
inspection showed 0 keys while the app's own rate-limit headers kept
incrementing, because the app wasn't talking to that container at all.

## Problem

Two independent processes were both listening on port 6379 on the same dev
machine, confirmed via `netstat -ano | grep 6379` + `tasklist`:

- `com.docker.backend.exe` — Docker Desktop's real forwarder for the
  `auctionx-redis` container, bound to the wildcard address (`0.0.0.0:6379`
  / `[::]:6379`).
- `wslrelay.exe` — WSL2's own automatic localhost-forwarding, exposing a
  port bound *inside* some WSL2 distro (wherever the unrelated project runs
  its own Redis) to Windows, bound specifically to loopback
  (`127.0.0.1:6379` / `[::1]:6379`).

Node's `localhost` resolution picks the more specific loopback-only bind
over the wildcard one for the same port number — confirmed directly with a
live `redis-cli MONITOR` on the Docker container during a real login
request: nothing showed up until this fix, then every `EVAL`/`INCR`/
`EXPIRE` appeared immediately once the app was pointed at the right port.

This is a known WSL2 behavior, not a misconfiguration on either side: any
TCP listener inside *any* WSL2 distro is automatically forwarded to Windows
`localhost` by `wslrelay.exe`, and it happened to collide with this
project's own Docker-published port.

## Options considered

**Find and stop whatever's using port 6379 inside WSL2.** Rejected —
that's another project's infrastructure on this machine, not something to
touch without knowing what depends on it. Section 82's "never make huge
unrelated changes" extends to not taking down someone else's running
service to make room for this one.

**Move AuctionX's Redis to a different host port instead.** Chosen — fully
self-contained within this project's own `docker-compose.yml`/`.env`, zero
risk to the other project, and permanent: it doesn't matter whether that
other WSL2 service is still running, restarted, or replaced by something
else later, because AuctionX no longer contests port 6379 at all.

## Decision

- `docker-compose.yml`'s `redis` service now publishes `6380:6379` instead
  of `6379:6379`. The container's *internal* port stays Redis's normal
  default (6379) — only the host-side mapping moved, since nothing inside
  the Docker network cares what host port it's reachable on.
- `REDIS_URL`'s default in `config/env.ts` and `.env.example` changed to
  `redis://localhost:6380`, and the developer's own local `.env` updated to
  match.
- No application code changed — `infrastructure/redis/client.ts` just
  connects to whatever `env.REDIS_URL` says, same as always.

## Tradeoffs

- Anyone else setting up this project fresh on a machine WITHOUT this
  particular WSL2 collision would have worked fine on the old default
  (6379) — this fix trades a slightly non-default port for correctness on
  the machine that actually hit the problem. Low cost: it's one config
  line, documented here and at both places it's set.
- If Docker Desktop's own host-port forwarding behavior ever changes (e.g.
  a future version binds more specifically, or WSL2 stops auto-forwarding
  arbitrary distro ports), this could become unnecessary — not worth
  reverting speculatively; revisit only if it's ever independently
  confirmed fixed upstream.

## Consequences

- Verified for real, not just by re-reading config: `docker exec
  auctionx-redis redis-cli FLUSHALL`, then a live login request, then
  `redis-cli MONITOR` on the container showed the exact `EVAL`/`INCR`/
  `EXPIRE` sequence from `middleware/rateLimit.ts` landing on the Docker
  container in real time, and `DBSIZE` went from 0 to 2 (one `api:` key,
  one `auth:` key) immediately after.
- Full `rateLimit` + `auth` test suites re-run against the corrected
  instance: 43/43 passing (6 suites), including the dedicated fail-open
  simulation.
- AuctionX's rate-limit data no longer commingles with an unrelated
  project's Redis instance on this dev machine.
- This also resolves the practical annoyance that made this worth fixing
  now: clearing stuck rate-limit keys via `docker exec auctionx-redis
  redis-cli` (the established precedent from earlier sessions) actually
  does something again.

## Revisit Conditions

- If this project is ever set up on a machine where port 6380 is ALSO
  contested (unlikely, but possible), the same investigation approach
  applies: `netstat`/`tasklist` to identify the real listener, then move to
  a free port rather than fighting over the contested one.
- Production deployment (Section 83, Render/Fly + a managed Redis like
  Upstash) is unaffected — this only matters for `docker-compose.yml`'s
  local host-port mapping, never for a real `REDIS_URL` pointing at a
  managed provider.
