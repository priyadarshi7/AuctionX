# 0024 — Local database backups, after a real data-loss incident

## What happened (2026-09-28, ~09:53 UTC)

While generating a migration for the Orders/Payments task (ORDER-001), I
(Claude, operating this repository) ran:

```
npx prisma migrate diff --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "postgresql://auctionx:auctionx_dev_password@localhost:5432/auctionx" \
  --script
```

`--shadow-database-url` must point at a database Prisma is free to drop and
rebuild from scratch as scratch space for computing the diff — that's what
"shadow" means. I pointed it at the **real, live local dev database**
instead of a separate, disposable one. Prisma dropped everything in it and
replayed migration history to reconstruct the schema (for the diff), which
left the schema structurally correct but **every row of data gone**: all
`users`, `auctions`, `bids`, `refresh_tokens` — including the developer's
own manually-created "House" test auction and their account, referenced
throughout earlier PROGRESS.md entries.

Confirmed via `docker logs auctionx-postgres`: a burst of heavy
checkpoint/DDL activity at 09:53:15–09:53:26 UTC, exactly matching when the
command ran, followed by an attempted `DROP TABLE _prisma_migrations`
(itself now missing) — consistent with the shadow-database teardown/rebuild
sequence running directly against the real database.

## Recoverability

**Not recoverable.** There was no backup of any kind for this database
before this incident — no `pg_dump` cron, no WAL archiving, no snapshot.
The named Docker volume (`auctionx_postgres_data`) only ever holds current
state; there is nothing to restore from. This is acknowledged directly to
the developer, not minimized.

## Why this was possible in the first place

This project already has a precedent for exactly this class of problem —
ADR-0022's addendum documents `s3mock` silently losing every uploaded image
on a container recreate because there was no volume, discovered the same
way (a real "my data disappeared" report). The fix there was a Docker named
volume with correct persistence env vars. Postgres already had a named
volume (`postgres_data` in `docker-compose.yml`), so a container
recreate/restart was never the risk for this table — but a volume only
protects against losing the container; it does nothing to protect against
an operation that runs directly, successfully, against the volume's live
contents and deletes what's inside it. That gap — no independent backup, so
a single bad command has no undo — was still open, and this incident is
what found it.

## Decision

Add a manual, developer-run backup/restore pair:

- `services/api/scripts/db-backup.ts` — `docker exec`'s `pg_dump` against
  the running `auctionx-postgres` container, writes a timestamped
  `.sql` dump to `backups/postgres/` at the repo root.
- `services/api/scripts/db-restore.ts` — takes an explicit file path
  (never "restore latest" — a destructive operation should never have an
  implicit default) and pipes it into `psql` via `docker exec -i`.
- `npm run db:backup` / `npm run db:restore -- <path>` at the repo root.
- `backups/` is gitignored — a dump contains password hashes and real
  email addresses, and must never be committed (Section 28 — never log/
  leak sensitive data; the same reasoning that keeps `.env` out of git).

**Deliberately NOT automated/scheduled.** This is local dev data on a
single machine, not a production system — Section 79's "backups, disaster
recovery, capacity planning" is real but scoped to an actual deployment
(Phase 13+), not local Docker Compose. A cron/scheduled backup here would
be solving a problem this project doesn't have yet (Section 80 — don't
over-engineer past the current problem). What this DOES fix: the specific
failure mode that just happened — a destructive command with no undo — now
has a two-line-command undo, if the developer remembers to back up first.

## Tradeoffs

- Still manual — nothing stops a repeat of this exact incident on a day
  nobody happened to run `db:backup` first. The honest fix for that is
  "be far more careful before pointing any tool's connection string at a
  real database," not tooling; this ADR exists partly as that reminder to
  future-Claude and future-sessions, not just as a script.
- `pg_dump`'s plain SQL format (not `--format=custom`) was chosen for
  readability/diffability of what's in a backup over restore speed or
  compression — irrelevant at this data volume (a local dev DB with no
  binary columns; images are referenced by URL, not stored as bytes,
  per MEDIA-001).

## Consequences

- The developer's pre-incident data (their account, the "House" auction)
  is permanently gone and was not recreated — there was nothing to recreate
  it from. They will need to re-register and re-create any auctions they
  want to keep testing with.
- Going forward, `npm run db:backup` before any migration-history operation
  (not just `migrate dev`/`deploy`, but especially `migrate diff`,
  `migrate resolve`, or any raw `db execute`) is the practice; this should
  become as automatic as running the test suite before considering a task
  done.

## Revisit conditions

- When a real deployment exists (Phase 13+), replace this with the actual
  managed-provider backup story (Neon/Supabase both offer point-in-time
  recovery on their free tiers — verify current limits at that time,
  Section 83) rather than this manual local script.
