# ADR-0039: Admin foundation — creation, user moderation, audit log

## Context

The `ADMIN` role and `requireRole` middleware existed (AUTH-005), with one
endpoint: `PATCH /auth/users/:userId/status`. It had no audit trail, no
guardrails (an admin could suspend themselves or another admin), no way to
list users, and no defined way for the first admin account to come into
existence. An admin panel (user management, auction moderation, order
tools) needs all of that, plus a record of who did what.

## Problem

1. How does an admin account get created without creating an attack surface?
2. Admin actions must be attributable and permanent.
3. Moderation must actually take effect, but access tokens are stateless JWTs
   (`authenticate` never reads the database), so a banned user's already-issued
   token kept working until it expired (up to 15 minutes).

## Options Considered

- **Admin creation:** a CLI script vs an `ADMIN_EMAILS` env allowlist vs a
  secret signup endpoint. An env allowlist auto-promotes by identity at login,
  which widens the trust surface (e.g. an unverified-email takeover of a listed
  address). A signup endpoint is a standing target.
- **Audit log with foreign keys** vs **plain ids.**
- **Making `authenticate` check the database** on every request (solves the
  stale-token window globally) vs **checking status where it matters.**
- **Keep the old endpoint** alongside the new one vs **replace it.**

## Decision

- **Only a CLI script creates admins:** `npm run make-admin -- <email>`
  (`--demote` to reverse). Needs shell access to the deployment, so the API
  exposes nothing for an attacker to call. It writes its own audit entry
  (`actorId` null, `metadata.via = "cli"`).
- **New `admin` module** under `/api/v1/admin`, with `authenticate` +
  `requireRole('ADMIN')` applied once to the whole router so a future endpoint
  can't forget the gate: user list (search, role, status filters, keyset
  pagination), audited status change, audit-log list.
- **`AdminAuditLog` table, append-only, no foreign keys.** An audit trail must
  outlive what it describes; a real FK would block or cascade-erase history
  when a user is deleted. The status change and its audit row are written in
  one transaction, so there is never an action without a record or the
  reverse. `action` is a free string (like `OutboxEvent.topic`) so new admin
  actions don't each need a migration.
- **Guardrails:** an admin cannot change their own status (a mis-click must
  not strand the only admin) and cannot moderate another admin via the API
  (demotion is deliberately out-of-band, so a compromised admin session can't
  be used to ban the other admins). Suspending or banning requires a reason;
  reinstating doesn't. Re-applying the current status succeeds and records
  nothing; two admins making the same change concurrently produce one change
  and one entry (guarded `UPDATE ... WHERE status != new`).
- **Status is re-checked where it matters, not on every request:** `placeBid`
  and `createNewAuction` already load the user, so they now also reject a
  non-`ACTIVE` account with `ACCOUNT_DISABLED` (403). Login and token refresh
  already refused non-active accounts.
- **The old `PATCH /auth/users/:userId/status` is removed**, not kept: two
  paths to the same power, one unaudited and unguarded, is worse than one.
  Its tests moved to the admin suite.

## Why

Least attack surface for creating admins; an audit log that can't be
rewritten by cascades; and a fix for the ban window that costs zero extra
queries because the user row is already in hand.

## Tradeoffs

- A banned user's token still works for **other** endpoints (viewing, paying
  an existing order, shipping) until it expires, at most 15 minutes. Only
  bidding and listing are closed. Closing it globally means a DB or Redis
  lookup per request, which is a real latency cost on every API call.
- Demoting or banning an admin needs shell access, not a button. Intentional,
  but inconvenient.
- Because the audit log has no FKs, `actorId`/`targetId` can point at rows
  that no longer exist; the UI must tolerate that.
- A role change made by the script only takes effect in the user's next access
  token (the role is a JWT claim), i.e. after they log in again or refresh.

## Consequences

An audited, guarded foundation for the admin panel. Later admin tasks
(auction moderation, order tools) write to the same log.

## Revisit Conditions

- If the 15-minute residual window matters (e.g. real abuse), add a per-
  request status check backed by a short Redis cache of banned user ids.
- Add `actor` display data (email/name snapshot) to audit entries if the
  panel needs to show who acted after the actor's account is gone.
- Two-person approval for bans, or time-boxed suspensions, if moderation
  volume grows.
