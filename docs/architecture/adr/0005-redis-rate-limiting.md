# 0005 — Redis-Backed Rate Limiting (Fixed Window, Fail-Open)

## Context

`CLAUDE.md` Section 30 requires different rate-limit strategies per endpoint
class (login/register: strict; browsing: high) and calls out Redis as the
mechanism for distributed rate limiting. Section 4 plans multiple API
instances behind a load balancer from Stage 2 onward. This is the first
piece of Redis infrastructure introduced into the system.

## Problem

Two distinct problems: (1) auth endpoints (`/register`, `/login`,
`/refresh`) need brute-force/credential-stuffing protection, and (2) the
general API needs a baseline policy that treats identified (authenticated)
callers differently from anonymous ones — a stricter ceiling for traffic
that's only identifiable by a spoofable/shareable IP address, a more
generous one for traffic tied to a known account.

## Options Considered — storage

1. **In-memory counters per process** — zero infra, but each of the
   eventual multiple API instances (Section 4) would track its own count
   independently: the effective limit multiplies by instance count, counters
   vanish on every restart/deploy, and an attacker can trivially evade the
   limit just by landing on a different instance.
2. **Redis, shared across instances** — one counter every instance reads
   and writes, so the limit holds regardless of which instance handles a
   given request. This is the "distributed coordination" use case Section
   12 lists as a legitimate reason to reach for Redis — not raw speed.

## Options Considered — algorithm

1. **Sliding window (log or weighted counter)** — most accurate, no
   boundary-burst gap, but costs more per check (a sorted set, or two
   weighted fixed-window reads) for precision this specific threat model
   doesn't need.
2. **Token bucket** — good when bursts should be tolerated (e.g. browsing),
   but that's not what auth endpoints need — no legitimate login flow
   requires bursting.
3. **Fixed window (`INCR` + `EXPIRE`)** — chosen. One Redis round trip, easy
   to reason about. Known imprecision: a client can send close to 2x the
   limit by timing requests around a window boundary. Acceptable here
   because the actual goal is defending against *sustained* brute force, not
   precise quota accounting — the boundary case is a minor, bounded gap, not
   an exploitable unlimited one.

## Decision

Redis-backed fixed-window counters, via an atomic `INCR`+conditional-`EXPIRE`
Lua script (one round trip; prevents a window where a crash between
separate INCR/EXPIRE calls could leave a key with no TTL, i.e. permanently
locked out). Two limiter instances:

- `authRateLimit`: strict (10 / 15 min), always IP-keyed — `/register`,
  `/login`, `/refresh` are inherently pre-authentication, so there is no
  identity to key by other than IP.
- `apiRateLimit`: applied globally to `/api/v1/*` (excluding `/liveness`,
  `/readiness`). Keyed and capped by whether `req.user` is populated —
  authenticated (300/min, keyed by user id) vs anonymous (60/min, keyed by
  IP). Requires a new `optionalAuthenticate` middleware ahead of it, which
  populates `req.user` best-effort from a Bearer token but never rejects a
  request for lacking one.

Both limiters stack on the same request where applicable (e.g. `/login`
counts against both) — deliberate, not an oversight: they're independent
policies answering different questions ("is this specific dangerous
endpoint being brute-forced?" vs "is this caller generally over budget?").

## Why fail-open, not fail-closed

If Redis is unreachable, the request is let through and the error is
logged, rather than rejected. Rate limiting is a defensive layer, not core
business correctness — unlike bid processing, where Section 12 is explicit
that Redis must never be the source of truth for anything that actually
needs to be correct. A Redis outage taking down all auth/API traffic would
be a strictly worse outage than a brief, logged loss of throttling
(Section 40's general principle: a dependency outage shouldn't cascade into
an outage of unrelated, more-critical functionality).

## Why REDIS_URL gets a default, unlike DATABASE_URL/JWT_ACCESS_SECRET

Those two are fail-fast, no-default env vars because the app cannot
function at all without them. `REDIS_URL` defaults to
`redis://localhost:6379` because the app must still boot and serve traffic
with zero Redis available — that's the whole point of failing open. Making
it a hard-required var would make a defensive, optional layer into an
availability dependency, which contradicts the design.

## Tradeoffs

```text
+ Distributed: one counter across every API instance, not per-process
+ Atomic INCR+EXPIRE: no window for a key to end up with no TTL
+ Fails open: a Redis outage degrades protection, not the whole API
+ No persistent volume needed: counters are inherently disposable
- Fixed window allows a bounded 2x burst right at a window boundary
- Fail-open means a sustained Redis outage removes rate-limit protection
  entirely for its duration — an accepted tradeoff, not a hidden one
- One more piece of infrastructure to run locally (docker-compose) and
  operate in production
```

## Consequences

- `docker-compose.yml`: added a `redis` service, no volume (contrast
  deliberately with `postgres`'s named volume).
- `optionalAuthenticate` added alongside the existing `authenticate` — a
  second, reusable primitive for endpoints that behave differently for
  logged-in vs anonymous callers without requiring login (Section 30's
  example: auction browsing).
- Server shutdown now also closes the Redis connection (Section 69),
  though — unlike Prisma's — this isn't safety-critical, just handle
  hygiene.
- **Verified live**: 10 login attempts pass through (each correctly
  returning 401 for bad credentials), the 11th and 12th are rejected with
  429 and `X-RateLimit-Remaining: 0`; the global limiter's anonymous-tier
  counter on a separate `/me` check correctly reflects all prior `/api/v1`
  traffic (14 requests counted against the 60/min anonymous budget),
  confirming the two limiters stack as designed rather than being tested in
  isolation only.
- **Test-environment note**: the full Jest suite makes far more than 10
  register/login calls against one shared test-runner IP within one Redis
  window. Coupling functional tests to a production security threshold
  would make them flaky for the wrong reason, so both limiters use a much
  higher ceiling when `NODE_ENV=test`. The actual blocking mechanism (does
  it block at N, correct headers, per-key isolation, fail-open) is tested
  directly against a small dedicated instance in `tests/rateLimit.test.ts`,
  not indirectly through these production-configured ones.

## Revisit Conditions

- If fixed-window's boundary-burst imprecision shows up as an actually
  exploited gap (evidenced, not hypothetical), move to a sliding-window log
  for the endpoints where it matters.
- If a specific endpoint needs burst tolerance (e.g. a client legitimately
  issuing a quick batch of reads), consider token bucket for that endpoint
  specifically rather than changing the global algorithm.
- If Redis's own availability becomes a demonstrated operational problem
  (not hypothetical), consider a local in-process fallback limiter as a
  second layer under fail-open — not before there's evidence it's needed.
