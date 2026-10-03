# ADR-0040: Admin panel — auction moderation, orders overview, stats, UI

## Context

ADR-0039 gave the platform audited admin accounts and user moderation. The
rest of an admin panel was missing: no way to take a problematic auction
offline, no cross-user view of orders (including the paid-but-cancelled
orders ADR-0038 can produce), no at-a-glance numbers, and no UI at all.

## Problem

1. Moderating someone else's auction must be safe against concurrent state
   changes, especially the closing worker ending it at the same moment.
2. Admins need to see orders that need a manual refund.
3. The UI must not become the only line of defence.

## Options Considered

- **Reuse the seller-facing `pause` / `cancel` functions for admins.** They
  are read-then-write (`requireOwnedAuction`, then an unconditional `UPDATE`)
  and check ownership. Wrong ownership model, and the race below.
- **Guarded moderation in the admin module.** Chosen.
- **A separate admin SPA / app.** Unjustified for four read-heavy pages; the
  existing app, auth store and UI kit are reused instead.
- **Stats via a cached/materialized snapshot** vs **live queries.** Live,
  until measured to be a problem (Section 62).

## Decision

- **Moderation is one guarded transaction.** `POST /admin/auctions/:id/moderate`
  takes `pause | resume | cancel`. The allowed source states live in the
  `UPDATE ... WHERE status IN (...)`, evaluated on the committed row, so an
  admin click racing the closing worker (or another admin) matches nothing
  instead of overwriting state. Example prevented: cancelling an `ENDED`
  auction that already has an Order. `resume` also requires the scheduled end
  to still be in the future. In the same transaction: audit entry, search
  reindex event, and an `auction.moderated` event; after commit, the cache
  invalidation + websocket signal every lifecycle change already does.
- **Reasons:** required for pause and cancel (stored in the audit log and sent
  to the seller), optional for resume.
- **Seller notification:** `AUCTION_MODERATED` (new enum value) via the
  existing outbox → Kafka → notifications consumer path, on the existing
  `auction-events` topic (the 5-topic cap, ADR-0036).
- **Read endpoints:** `GET /admin/auctions` (any status, title search, seller
  email, bid count), `GET /admin/orders` (status filter and `needsRefund`, with
  buyer/seller emails), `GET /admin/stats`. All keyset-paginated like the rest
  of the API. "Needs refund" is defined once: `CANCELLED` with a `SUCCEEDED`
  payment.
- **Stats** are live aggregate queries issued concurrently (counts and
  `GROUP BY`), refreshed by the dashboard every 30s. Revenue = sum of orders
  that are `PAID`, `SHIPPED` or `DELIVERED`.
- **UI:** `/admin` (dashboard), `/admin/users`, `/admin/auctions`,
  `/admin/orders`, `/admin/audit-log`, under a layout that shows non-admins an
  "Admins only" message. An Admin link appears in the nav for admins only. The
  layout gate is UX only; every endpoint independently enforces `ADMIN`
  server-side (ADR-0039), so bypassing the UI yields nothing.

## Why

Guarded updates reuse the project's existing concurrency idiom (ADR-0038) and
need no extra locking. Keeping the admin surface in one module with a single
router-level role gate means a new endpoint cannot be added without it.

## Tradeoffs

- The seller-facing pause/cancel remain read-then-write and still have the
  race described above. Left alone deliberately (out of scope, and the window
  is tiny for a seller acting on their own auction); flagged here, not
  silently changed.
- Stats are computed on every request: fine at this scale, `COUNT(*)` over
  `bids`/`users` will need caching or a rollup as tables grow.
- Bidders on an admin-cancelled auction are not notified, only the seller.
- Refunds are still manual: the panel surfaces the orders that need one but
  cannot issue the refund.
- The frontend has no automated tests (no runner exists); the pages were
  type-checked, linted, built, and the endpoints they call are covered by
  backend tests, but the UI itself has not been exercised in a browser.

## Consequences

An admin can see platform health, find and act on bad users and auctions, and
spot orders needing a refund; every action leaves a permanent audit entry.

## Revisit Conditions

- Notify bidders when an auction with bids is cancelled by an admin.
- Cache or pre-aggregate stats when the dashboard query becomes slow.
- An admin "cancel order" / "issue refund" action once real Stripe lands.
- Browser-level tests (Playwright) for the admin flows.
- Fix the seller-facing pause/cancel race with the same guarded-update
  approach.
