# 0026 — Notifications

## Context

Section 1 lists "receive notifications" as a core feature, and Section 4's
Stage-1 modular-monolith diagram has always included a Notification Module
alongside Auth/User/Auction/Bid/Payment — nothing had been built there.
Users had no way to learn they'd been outbid, won an auction, had an
auction go unsold, or got paid, short of manually revisiting the exact
page.

## Problem

Which events are worth a notification, and how should one actually reach
the user — reliably, but without introducing infrastructure this project
doesn't have yet (Kafka/Outbox is still Phase 7, untouched)?

## Options considered

**What triggers a notification?**

Kept deliberately tight — five triggers, all actionable, not a
notification for every possible state change:

- `OUTBID` (buyer) — someone else's bid superseded theirs.
- `AUCTION_WON` (buyer) / `AUCTION_SOLD` (seller) — the same closing event,
  told from each side.
- `AUCTION_RESERVE_NOT_MET` (seller) — the auction ended unsold despite
  bids.
- `PAYMENT_RECEIVED` (seller) — a payment webhook succeeded. The buyer
  already sees this live via the order page's polling (ADR-0025), so a
  redundant buyer-side notification wasn't worth adding; the seller has no
  other way to learn "the money is in, ship the item."

Explicitly NOT notified: a `NO_BIDS` closing (nothing actionable to tell
anyone), a bidder outbidding themselves (their own later bid already IS
the acknowledgment), a `FAILED` payment (the buyer sees this inline on the
order page — the pay button simply becomes available again).

**Where does a Notification get created?**

- *Async, via an event bus once Kafka/Outbox exists.* The eventual shape,
  and arguably the "correct" one for a true Notification microservice
  (Section 4's final architecture). Rejected for now, same reasoning as
  ADR-0023's Order creation: Kafka doesn't exist yet, and `Notification`
  lives in the same Postgres database as everything that triggers it —
  introducing an event bus to write one more row in an already-open
  transaction is complexity with no present payoff.
- **Synchronously, inside the SAME transaction as the triggering event.
  Chosen.** A bid's outbid notification is created inside
  `placeBidTransactionally`'s existing lock (`bids/repository.ts`), under
  the same row lock that already serializes concurrent bids — reading "who
  was previously winning" there, not after commit, is what makes it
  correct: querying for the 2nd-highest bid after the fact would be a real
  race (another bid could land in between and answer a different
  question). An auction's won/sold/reserve-not-met notifications are
  created inside `closeAuctionIfExpired`'s transaction (`auctions/
  repository.ts`), right alongside Order creation. A payment's
  `PAYMENT_RECEIVED` notification is created inside
  `applyPaymentWebhookEvent`'s transaction (`payments/repository.ts`),
  using the `Order.update()` call's own returned row for `sellerId`/
  `amountCents` rather than an extra read.

**How does delivery work — and what happens if delivery fails or nobody's
connected?**

`Notification` is a real Postgres table — the source of truth, not a
transient event. Section 39 ("delayed notifications are generally
preferable to blocking auction correctness") is about latency, not
durability: a user offline when outbid must still see it when they
return, so the row itself, not a WebSocket message, is what actually
"delivers" a notification. A WebSocket push (see below) is strictly
additive: if it fails silently (nobody connected, a dropped connection),
`GET /api/v1/notifications` is still there, unconditionally correct.

`notifications.auctionId`/`orderId` are plain nullable strings, not Prisma
relations with an enforced FK — deliberately different from `Order`'s
relations (`onDelete: Restrict` everywhere, protecting real financial
correctness). A notification is read-mostly UI convenience data; a
dangling reference here is a rendering nuisance (a link that 404s), not a
correctness bug, so it doesn't need that machinery. In practice nothing in
this schema currently deletes an Auction/Order anyway.

**Real-time delivery**

The WebSocket gateway (ADR-0020) only had per-*auction* rooms. Added a
per-*user* room (`infrastructure/websocket/gateway.ts`'s `userRooms`): a
connection that successfully sends `auth` is now automatically joined to
its own user room — no separate subscribe step, since "deliver my
notifications to me" isn't an opt-in the way watching one specific auction
is. `pushToUser`/`pushNotification` (mirroring `broadcastToAuction`/
`notifyAuctionChanged`) are called AFTER each trigger's transaction
commits, never from inside it — same reasoning as `notifyAuctionChanged`
already being called post-commit: don't tell a client about something
until it's actually durably true.

## Decision

- `Notification` model + `NotificationType` enum (schema.prisma), migration
  `20260928113509_add_notifications`.
- `modules/notifications/` — `GET /api/v1/notifications` (own
  notifications, newest first, plus `unreadCount`), `POST /:id/read`,
  `POST /read-all`. All behind `authenticate` — no anonymous-viewer concept
  for notifications, same as orders.
- Three existing files gained a trigger each, all following the same
  shape (create inside the existing transaction, push after commit):
  `bids/repository.ts` + `bids/service.ts`, `auctions/repository.ts`,
  `payments/repository.ts`.
- Frontend: `NotificationBell` (unread badge, dropdown, mark-read on
  click, mark-all-read), `useNotificationSocket` (app-wide connection
  mounted from `NavBar.tsx`, present in the root layout so it persists
  across navigation for an authenticated session's lifetime).

## Tradeoffs

- `data: Json` on `Notification` is one loosely-typed column covering five
  different payload shapes, rather than a column per possible field —
  most rows would leave most columns null otherwise, and this data is
  read, never queried/filtered on, so there's no indexing cost to
  normalizing further. The frontend's `describeNotification` (lib/
  notifications.ts) is the one place that has to know each type's actual
  shape; a wrong assumption there fails soft (a `formatCents(undefined)`
  ends up "$0.00"), not with a crash.
- Single-instance, in-memory `userRooms`, same caveat as the auction rooms
  it mirrors (ADR-0020) — needs Redis Pub/Sub fanout the moment a second
  gateway instance exists.
- No email notifications. In-app + WebSocket covers the "user is actively
  using the product" case; an offline user only finds out on their next
  visit. Acceptable for now — Section 39's "delayed is fine" — and the
  `EmailSender` port (ADR-0006) already exists if this needs revisiting.

## Consequences

- 162/162 tests passing (155 prior + 7 new: outbid-notifies-the-right-
  person-and-not-yourself, won/sold pair, reserve-not-met, payment-
  received, list-with-unread-count, mark-one-read-with-ownership-check,
  mark-all-read), build/lint clean on both workspaces.
- Verified live end-to-end in a real browser (Playwright): logged in as a
  bidder, had a SEPARATE curl-driven bidder outbid them mid-session, and
  watched the notification bell's unread badge appear with NO page reload
  or manual refetch — a genuine WebSocket push, not a polling artifact —
  then confirmed clicking it navigated to the auction and cleared the
  unread count, persisted correctly in the database.
- A minor eslint config change: `no-unused-vars`'s `varsIgnorePattern`
  now matches its existing `argsIgnorePattern` (`^_`) — needed for
  `auctions/repository.ts`'s "strip an internal-only `notifications` field
  before returning the public result type" pattern, which has no
  nameless-discard syntax in TypeScript destructuring.

## Revisit conditions

- Move notification creation to an event-consumer once Kafka/Outbox
  (Phase 7) exists and something outside this monolith needs to react to
  these same triggers.
- Add email delivery (via the existing `EmailSender` port) if real usage
  shows users missing time-sensitive notifications (e.g. `AUCTION_WON`
  needing prompt payment) between visits is an actual problem, not a
  hypothetical one.
- Add Redis Pub/Sub fanout for `userRooms` at the same time `rooms` gets
  it — both are the identical single-instance limitation.
