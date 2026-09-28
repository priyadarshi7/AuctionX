// Manual full reindex — server.ts already runs this automatically once,
// the moment the OpenSearch index is first created (ADR-0031). This is
// for the OTHER times a full rebuild is genuinely needed: after a mapping
// change (ensureAuctionIndex only creates a MISSING index, it never
// migrates an existing one's mapping), or to recover from any suspected
// drift between Postgres and the index without deleting the index first.
// Run standalone (not via server.ts's boot sequence), so — same as
// server.ts itself — .env isn't loaded automatically until this does it.
import 'dotenv/config';
import { reindexAllAuctions } from '../src/modules/search/service';

reindexAllAuctions()
  .then(({ indexed }) => {
    console.log(`Reindexed ${indexed} auction(s).`);
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error('Reindex failed:', err);
    process.exit(1);
  });
