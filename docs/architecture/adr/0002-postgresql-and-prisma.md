# 0002 — PostgreSQL as Source of Truth, Prisma as ORM

## Context

Every critical piece of business state — users, auctions, bids, orders,
payments — needs a system of record with real transactional guarantees.
`CLAUDE.md` Section 7 mandates PostgreSQL for this; Section 8 mandates
Prisma with version-controlled migrations.

## Problem

Bidding is a high-contention workflow (Section 9): many users can attempt to
bid on the same auction simultaneously, and correctness (no lost bids, no
double winners) matters more than raw throughput. The database needs strong
consistency guarantees (ACID transactions, row locking, isolation levels),
not just "a place to put JSON."

## Options Considered

1. **NoSQL document store** (e.g. MongoDB) — flexible schema, but no native
   multi-row ACID transactions with the maturity Postgres has for the
   bid-processing transaction (bid insert + auction row update + outbox
   insert, atomically).
2. **PostgreSQL, raw SQL / query builder (e.g. Knex)** — full control over
   every query and generated SQL, but hand-written migrations and no
   generated, type-safe client; more boilerplate for basic CRUD.
3. **PostgreSQL + Prisma** — type-safe generated client, first-class
   migration tooling (`prisma migrate`), still allows raw SQL
   (`$queryRaw`/`$transaction`) when Prisma's query API isn't expressive
   enough (e.g. `SELECT ... FOR UPDATE` for pessimistic locking).

## Decision

Use PostgreSQL as the single source of truth for transactional state, with
Prisma as the ORM/migration tool for `services/api`.

## Why

- Postgres gives us row-level locking, `SELECT FOR UPDATE`, and configurable
  isolation levels — the actual tools the bid-processing workflow (Section
  10) will need, not a marketing bullet point.
- Prisma's migration files are plain SQL, checked into git
  (`prisma/migrations/`) — schema changes are reviewable diffs, never manual
  production changes (Section 8).
- Prisma remains an abstraction, not a wall: `$queryRaw` and
  `prisma.$transaction([...])` are both available for the cases (like
  concurrency control) where the generated query API isn't precise enough.

## Tradeoffs

```text
Prisma:
+ Generated, type-safe client — schema and query types can't drift apart
+ Migration files are plain SQL, reviewable in PRs
+ $queryRaw/$transaction escape hatches when needed
- Some Postgres features (e.g. citext, partial indexes with complex
  expressions) need raw SQL in migration files, not the Prisma schema DSL
- An extra generated-code step (`prisma generate`) in the build/dev loop
- Connection pooling is per-process (PrismaClient's internal pool) — at
  higher instance counts this needs PgBouncer in front of Postgres
  (Section 44), not yet needed at our scale
```

## Consequences

- `services/api` now requires a running Postgres instance to boot
  meaningfully — `docker-compose.yml` provides one for local dev.
- `DATABASE_URL` is a required env var (Section 51: fails fast if missing).
- `/readiness` now performs a real `SELECT 1` against Postgres — this is the
  first endpoint where liveness and readiness diverge in practice (verified:
  stopping Postgres makes readiness return 503 while liveness stays 200).

## Revisit Conditions

- If read replica lag or connection-pool exhaustion shows up under real load
  testing (Section 44), introduce PgBouncer before considering anything more
  drastic.
- If a specific query pattern genuinely can't be expressed cleanly through
  Prisma (recurring, not one-off), drop to raw SQL for that query specifically
  rather than abandoning Prisma wholesale.
