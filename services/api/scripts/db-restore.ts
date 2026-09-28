import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// The other half of db-backup.ts (see its comment for why this exists).
// Deliberately requires an explicit file path argument — no "restore the
// latest backup" default — so running this is always a conscious, specific
// choice, never something that silently picks the wrong snapshot. This
// OVERWRITES the current contents of the local `auctionx` database
// (`--clean --if-exists` in the dump means the restore itself drops
// existing objects first); there is no undo except restoring a different
// backup.
const CONTAINER = 'auctionx-postgres';
const DB_USER = 'auctionx';
const DB_NAME = 'auctionx';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: tsx scripts/db-restore.ts <path-to-backup.sql>');
  console.error('This OVERWRITES the current contents of the local "auctionx" database. There is no undo.');
  process.exit(1);
}

const resolved = resolve(filePath);
if (!existsSync(resolved)) {
  console.error(`No such backup file: ${resolved}`);
  process.exit(1);
}

const sql = readFileSync(resolved, 'utf8');

console.log(`Restoring ${resolved} into database "${DB_NAME}" in container "${CONTAINER}"...`);

const result = spawnSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', DB_USER, '-d', DB_NAME], {
  input: sql,
  encoding: 'utf8',
  maxBuffer: 1024 * 1024 * 200,
});

if (result.error) {
  console.error('Failed to run docker exec — is Docker running and is the container named', CONTAINER, '?');
  console.error(result.error);
  process.exit(1);
}
if (result.status !== 0) {
  console.error('Restore failed:');
  console.error(result.stderr);
  process.exit(1);
}

console.log('Restore complete.');
if (result.stdout.trim()) {
  console.log(result.stdout);
}
