# 0031 — Three real search bugs: no partial-word matching, test data leaking into the real index, and no backfill for pre-existing auctions

## Context

All three reported or found directly from the developer's own live usage,
within hours of ADR-0029 shipping. First: typing "Pi" in the search box
didn't find "Pikachu Card," and typing "A" under the Everything Else
category returned a pile of "Test Lot"-titled results that don't
correspond to anything they created. Then, immediately after those two
were fixed: a real, pre-existing "Hello" auction still didn't show up for
an exact-word search of its own title — a third, different bug, not a
regression of the first two.

## Problem 1 — no partial/prefix matching

`queryAuctions` used a plain `multi_match` query. Confirmed directly
against OpenSearch: a query for `"Pi"` against a document titled
`"Pikachu Card"` returns zero hits. The standard analyzer tokenizes
"Pikachu" to the single token `pikachu`; a `multi_match` query only matches
complete tokens, so `pi` ≠ `pikachu`. This is correct behavior for
`multi_match` — it was simply the wrong query type for a search BOX that
needs to react as someone types, not just after they finish a whole word.

## Problem 2 — the real index had 107 stale test documents in it

Root cause, found in two layers:

**Layer 1**: `createAuction`/etc. (ADR-0029) publish a reindex event on
every mutation, including every auction created by every one of this
session's `npx jest --runInBand` runs. Test cleanup deletes those rows
directly from Postgres afterward — but nothing ever tells OpenSearch to
remove the matching document (there is no "row no longer exists" signal,
only reindex-ON-mutation). Every full-suite run left its test auctions
(titles like "Notifications Test Lot," "Bid Test Lot") permanently
orphaned in the SAME index the developer's own browser queries. Confirmed:
107 of 108 documents in the index were exactly this.

**Layer 2, found while fixing layer 1**: giving the OpenSearch INDEX a
`-test` suffix in `NODE_ENV=test` (mirroring `modules/search/consumer.ts`'s
existing `GROUP_ID` pattern) was NOT sufficient on its own. A live
`npm run dev` server is a separate, already-running process — its search
consumer is in a DIFFERENT consumer group (`search-consumer`, not
`search-consumer-test`), and Kafka delivers a full, independent copy of
every message on a topic to EVERY consumer group subscribed to it.
Consumer-group isolation only prevents two processes in the SAME group
from fighting over partitions (what it was originally built for,
ADR-0027); it does nothing to stop a completely different group from
independently consuming a shared topic. So even after the index-name fix,
running the suite again while the dev server was up put 8 new stale
documents into the real index — confirmed live, not assumed.

## Problem 3 — pre-existing auctions were never indexed at all

A real "Hello" auction, created well before Phase 9 existed, wasn't
findable even by its own exact, complete title. Checked directly against
OpenSearch (`GET /auctions/_doc/<id>`): `found: false`. Not a query bug —
the document genuinely never existed in the index.

Root cause: every reindex trigger (ADR-0029) fires on a MUTATION — create,
update, publish, a new bid, closing. A row that already existed when
Phase 9 shipped, and that nothing has touched since, has never had a
mutation happen to it since the reindex-event plumbing existed, so it has
never had a reindex event fire for it either. Reindex-on-mutation was
always going to leave every already-existing row un-indexed at the moment
the feature ships — this is the standard "backfill" problem any new
derived index has, and Phase 9 shipped without addressing it.

## Decision

**Fix 1**: `queryAuctions`'s `multi_match` now sets `type: 'bool_prefix'`.
This treats every term except the last as a normal term match and the
last term as a prefix match — designed specifically for "search as you
type," across the same weighted `title^2`/`description` fields as before.

**Fix 2**: two layers, matching the two layers of the problem.
- `modules/search/repository.ts`'s `INDEX` gets a `-test` suffix in
  `NODE_ENV=test` (kept — still correct defense-in-depth on its own).
- New `infrastructure/kafka/topics.ts` exports `SEARCH_EVENTS_TOPIC`,
  itself `NODE_ENV`-conditional (`search-events-test` vs `search-events`),
  used by BOTH publish sites (`auctions/repository.ts`,
  `bids/repository.ts`) and the consumer's subscription
  (`modules/search/consumer.ts`) — one shared constant, not three
  independently-typed literals that could drift. This is the fix that
  actually matters: a live dev server's consumer, subscribed only to the
  real `search-events` topic, now never even RECEIVES a test run's
  messages, regardless of index name or consumer group.

**Fix 3**: `modules/search/service.ts`'s new `reindexAllAuctions()` walks
every non-DRAFT auction in Postgres (keyset-paginated via the SAME
`AuctionListFilters`/cursor `auctions/repository.ts` already uses for
browsing, not a second pagination scheme) and upserts each into the
index. Wired into `server.ts`: `ensureAuctionIndex()` now returns whether
it actually CREATED the index (vs. found it already there), and
`reindexAllAuctions()` runs automatically right after, exactly once, only
when it did — so a genuinely fresh index (first boot, or the index was
deleted/rebuilt) always starts populated, with no manual step required.
Deliberately NOT wired as a call from inside `repository.ts` itself
(`ensureAuctionIndex`): `service.ts` already imports FROM `repository.ts`
(`queryAuctions`, `upsertAuctionDocument`), so calling back into it from
there would be a circular import for no real benefit when `server.ts`
already composes exactly this "do A, then B" sequencing for every other
piece of startup infrastructure. Also exposed standalone
(`npm run reindex:search`, `scripts/reindex-search.ts`) for the other time
a full rebuild is genuinely needed: a mapping change, since
`ensureAuctionIndex` only creates a missing index, it never migrates an
existing one's mapping.

## Consequences

- All three bugs verified fixed directly against the live API: `q=Pi` now
  returns `Pikachu Card`; `q=A&category=OTHER` now returns zero results
  (previously a pile of stale Test Lot documents); `q=Hello` now returns
  the real pre-existing "Hello" auction.
- The 107 (then, mid-fix, 8, then 1) stale documents already in the real
  index were reconciled by diffing indexed ids against actual Postgres
  auction ids and bulk-deleting the difference — a one-time operational
  cleanup, not a schema change.
- Verified the ROOT CAUSE of fix 2 is actually closed, not just the
  symptom: ran the full 165-test suite with the live dev server running
  (the exact condition that caused the leak) and confirmed via a direct
  index count that the real index held exactly the real documents
  throughout — the same live-dev-server-concurrent-with-tests scenario
  ADR-0030 verified for the outbox race.
- Verified fix 3's AUTOMATIC path end to end, not just the manual script:
  deleted the real index entirely, restarted the server, and watched
  `search.index_created` immediately followed by
  `search.reindex_all_complete: indexed: 2` in its own boot log, then
  confirmed both real auctions searchable straight after — no manual
  intervention.

## Revisit Conditions

- If OTHER Kafka topics (`bid-events`, `auction-events`, `payment-events`)
  ever grow a similar directly-user-visible pollution concern (today, a
  test-created Notification only affects a test user nobody looks at, so
  it's cosmetically invisible — unlike a shared, global search index),
  the same `infrastructure/kafka/topics.ts` pattern should extend to them
  too, rather than solving it ad hoc per topic again.
- `search-events-test`'s own topic — nothing currently consumes or cleans
  it up; it will accumulate indefinitely across test runs. Harmless (nobody
  queries it, it's not the real index), but worth a retention policy if it
  ever becomes an actual disk concern, same "not yet, no measured need"
  reasoning as `PROGRESS.md`'s other deferred retention items.
- `ensureAuctionIndex` only creates a MISSING index — it never detects or
  migrates a mapping change on an EXISTING one. A future mapping change
  needs `npm run reindex:search` run by hand after manually updating (or
  deleting and letting boot recreate) the index; this isn't automatic
  today and would silently keep using the old mapping otherwise.
