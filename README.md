# AuctionX

An industry-grade, learning-oriented AI auction platform. See `CLAUDE.md` for
the full engineering constitution driving this project's design decisions,
and `PROGRESS.md` for where the build currently stands.

## Structure

```text
services/api/     Modular-monolith backend (Express + TypeScript)
docs/architecture/adr/   Architecture Decision Records
PROGRESS.md       Session-to-session continuity: current phase/task
```

Frontend (`apps/web`) and shared packages (`packages/*`) will be added when
there is real content to put in them (see ADR-0001 for why we don't
pre-scaffold empty structure).

## Local development

```bash
npm install
cp services/api/.env.example services/api/.env
docker compose up -d              # Postgres, Redis, s3mock, Redpanda, OpenSearch
npm run --workspace=services/api prisma:migrate   # apply migrations
npm run dev:api      # start the API in watch mode (http://localhost:4000)
npm run test:api     # run the API test suite (needs the full docker-compose stack running)
npm run lint:api     # lint the API
```

Health checks: `GET /liveness` (never depends on the DB), `GET /readiness`
(does a real `SELECT 1` against Postgres) — see Section 70 of `CLAUDE.md` for
why these are kept separate.

**Back up local Postgres data before any migration-history operation**
(`prisma migrate diff`, `migrate resolve`, raw `db execute` — not just
`migrate dev`/`deploy`). There is no automatic backup; see ADR-0024 for why
this exists and what it does and doesn't protect against.

```bash
npm run db:backup                 # dumps to backups/postgres/<timestamp>.sql (gitignored)
npm run db:restore -- <path.sql>  # OVERWRITES current local DB contents — no undo
```

## Stack (current)

- Node.js + TypeScript (strict) + Express
- PostgreSQL + Prisma (see ADR-0002)
- Redis for distributed rate limiting (see ADR-0005) — not the source of
  truth for anything; fails open if unreachable
- Gmail SMTP (via nodemailer) for password-reset emails, behind an
  `EmailSender` port (see ADR-0006) — optional; falls back to logging
  emails instead of sending them if unconfigured
- Zod for env validation and request validation
- Pino for structured JSON logging
- Jest + Supertest for testing
- Redpanda (Kafka-API-compatible) + the Outbox pattern for durable
  async events (see ADR-0027)
- OpenSearch for full-text auction search — a derived index kept in sync
  via the same Outbox/Kafka mechanism, never the source of truth (see
  ADR-0029)
- WebSockets for live auction updates and notifications (see ADR-0020/0021)

This section (and the "Structure" one above) describes only the backend's
original foundation and is known to be stale — `apps/web` (Next.js
frontend), object storage, Orders/Payments, and Notifications have all
since been built. See `PROGRESS.md` for the actual current state; fixing
this file to match is tracked there, not done as part of this edit.
