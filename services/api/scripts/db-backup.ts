import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Local Postgres runs in Docker (docker-compose.yml's `postgres` service).
// This is the ONLY backup mechanism for local dev data after the 2026-09-28
// incident (PROGRESS.md, ADR-0024) where a misdirected
// `prisma migrate diff --shadow-database-url` pointed at the LIVE dev
// database instead of a disposable one, and wiped every row while leaving
// the schema itself intact. There is still no automatic/scheduled backup —
// this is a manual, developer-run safety net for local dev, not a
// production disaster-recovery strategy (Section 79 — that's a real, later
// concern once there's a real deployment to protect). Run this before any
// operation that touches migration history or the database directly, not
// just occasionally.
const CONTAINER = 'auctionx-postgres';
const DB_USER = 'auctionx';
const DB_NAME = 'auctionx';

const backupsDir = join(__dirname, '..', '..', '..', 'backups', 'postgres');
mkdirSync(backupsDir, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputPath = join(backupsDir, `auctionx-${timestamp}.sql`);

const result = spawnSync(
  'docker',
  ['exec', CONTAINER, 'pg_dump', '-U', DB_USER, '-d', DB_NAME, '--clean', '--if-exists'],
  {
    encoding: 'utf8',
    // A local dev DB with no large binary columns (images live in object
    // storage, referenced only by URL — MEDIA-001) stays small; 200MB is
    // generous headroom, not a real limit being approached.
    maxBuffer: 1024 * 1024 * 200,
  },
);

if (result.error) {
  console.error('Failed to run docker exec — is Docker running and is the container named', CONTAINER, '?');
  console.error(result.error);
  process.exit(1);
}
if (result.status !== 0) {
  console.error('pg_dump failed:');
  console.error(result.stderr);
  process.exit(1);
}

writeFileSync(outputPath, result.stdout, 'utf8');
console.log(`Backup written to ${outputPath} (${(result.stdout.length / 1024).toFixed(1)} KB)`);
