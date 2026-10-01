# 0033 — Soft email-verification gate, and transactional emails for the two events users most need off-site

## Context

`services/api/src/infrastructure/email/sender.ts` already existed with real
Gmail SMTP delivery (via nodemailer), backing password reset
(`requestPasswordReset`/`resetPassword` in `modules/auth/service.ts`) —
built, tested, and working, but with no frontend page to actually trigger
it (`/forgot-password` and `/reset-password` didn't exist in `apps/web`).
Separately, registration sent nothing at all: no `emailVerifiedAt` field
existed on `User`, and an account was fully usable — sell, bid, everything
— the instant it was created, with zero proof the email address was even
real.

Raised directly by the developer: "haven't you integrated the Mail
features? for register, email verification, password reset and other
things." Password reset turned out to already be half-built (backend only);
email verification didn't exist at all.

## Problem

Three things needed deciding, in order, before any code:

1. **What should an unverified account be allowed to do?** This decides the
   entire shape of the feature — a hard login gate is a different system
   than a soft one that only blocks specific actions.
2. **How does a fresh JWT access token (which only carries `{sub, role}`,
   `middleware/authenticate.ts`) reflect a verification that happens after
   the token was already issued?**
3. **Beyond verification itself, which existing in-app-only notification
   events (`modules/notifications/consumer.ts`) are worth also emailing,**
   given a user isn't necessarily watching the site when their auction
   sells or their payment clears?

## Decision

**Soft gate**, chosen directly with the developer over a hard login-time
gate or a purely informational (non-blocking) approach: registering and
logging in never require verification, and browsing is always open. Only
two actions are gated — creating an auction (`createNewAuction`,
`modules/auctions/service.ts`) and placing a bid (`placeBid`,
`modules/bids/service.ts`) — the two places trust actually matters for this
platform. Both check freshly, via `findUserById`, never trusting the JWT's
stale claims — the exact same "never trust client-controlled/stale
security state" reasoning `loginUser`'s `user.status !== 'ACTIVE'` check
already established. For bidding specifically, the check runs in
`placeBid` BEFORE `placeBidTransactionally` acquires the auction row's
lock — rejecting for a reason that has nothing to do with the auction's
state shouldn't pay for contention on a hot row (Section 64).

**Schema**: `User.emailVerifiedAt DateTime?` (null = unverified) and a new
`EmailVerificationToken` model — deliberately an exact structural copy of
the existing `PasswordResetToken` (same single-use opaque-token pattern,
`infrastructure/security/tokens.ts`'s `generateOpaqueToken`/
`hashOpaqueToken`), just a 24-hour TTL instead of 30 minutes: proving "I
can read this inbox" is lower-stakes than proving "I want to change this
account's password," and people don't always check email immediately.

**Transactional emails**: extended `modules/notifications/consumer.ts`
(already the single async, Kafka-driven mapping from domain event to
in-app `Notification` row) to also send email for exactly two cases: the
buyer on `auction.sold` ("you won"), and the seller on `payment.succeeded`
("payment received"). Chose these two specifically because they're the
events a user most needs to know about even when not actively on the site
— an outbid notification or a reserve-not-met notification can wait for
the next visit; a payment obligation or a payment confirmation generally
can't. `createNotificationIdempotently` was changed to return whether it
actually inserted a fresh row (vs. hit the idempotent-replay path) —
sending email as a side effect of a Kafka message is NOT naturally
idempotent the way the DB insert itself is (protected by
`@@unique([sourceEventId, userId])`), so a redelivery must be able to skip
the email while still being a correct no-op for the notification row.

**Frontend**: three new pages that didn't exist before this — `/verify-
email`, `/forgot-password`, `/reset-password` — plus a persistent
`VerificationBanner` in the root layout (shown whenever `user &&
!user.emailVerifiedAt`), and inline "Resend verification email" affordances
at the two exact moments a gate can actually be hit (the create-auction
form, the bid form) rather than only the passive banner.

## Why

**Soft over hard gate**: a hard gate (can't log in unverified) makes email
deliverability a single point of failure for the entire product — and this
project's only delivery mechanism is a personal Gmail account via SMTP
(`GmailEmailSender`), with no fallback provider configured. A soft gate
means a slow or lost verification email degrades one feature (selling/
bidding), not the whole login flow.

**Why over pure-informational (no gate at all)**: the two blocked actions —
listing an item, bidding real money against another user — are exactly the
places an unverified, possibly-throwaway email address is a real trust
gap (shill accounts, unreachable buyers who win and vanish). Browsing has
no such stakes, so gating it would only add friction with no matching
security value.

**Fresh DB check, not JWT claims**: the access token's 15-minute lifetime
means a token issued moments before verification completes would otherwise
carry a stale "unverified" claim for up to 15 minutes even after the user
verifies — worse, a token issued and never refreshed could claim
"verified" indefinitely if verification status were ever baked into the
token at issuance instead of checked live. One extra indexed `findUserById`
lookup on exactly two write paths is a cheap, correct price for this.

## Tradeoffs

```text
+ Verification email delivery failure never blocks registration or login
  (sendVerificationEmail catches and logs, same pattern as
  requestPasswordReset) — an operational problem, not a product outage.
+ Reuses 100% of the existing opaque-token/hash/TTL infrastructure — no new
  security primitive introduced, just a second table shaped like the first.
+ Transactional email piggybacks on infrastructure that already exists and
  is already correctly async/off-critical-path (Section 24) — no new Kafka
  topic, no new consumer.
- Two extra DB round-trips on the hot write paths (create-auction,
  place-bid) for every request, verified or not — small (single indexed PK
  lookup) but non-zero, and unconditional even for a long-since-verified
  seller who lists constantly.
- Gmail SMTP is a real, already-disclosed operational limit
  (infrastructure/email/sender.ts's own comment: ~500 emails/day on a
  personal account, no dedicated deliverability provider). Verification +
  password-reset + two transactional email types now all compete for that
  same cap — fine at this project's current zero-real-users stage, a real
  constraint the moment it has actual traffic.
- The soft gate is enforced in exactly two places by hand
  (createNewAuction, placeBid) — a THIRD future write path that should
  also require verification (e.g. a future "leave a review" feature) has
  to remember to add its own check; there's no single shared middleware
  enforcing this centrally, since the two gated actions live in different
  modules with different request shapes (one a plain POST body, one
  inside a locked transaction).
```

## Consequences

- Every existing backend test that registers a user and then creates an
  auction or places a bid needed its test-user fixture updated to mark
  `emailVerifiedAt` directly via Prisma (the same "reach into the DB
  directly for test setup convenience" convention these test files already
  used for forcing auction status, etc.) — a mechanical but repo-wide
  ripple, not a design flaw.
- `ForbiddenError` (`middleware/errors.ts`) gained an optional `code`
  parameter (defaulting to the existing generic `'FORBIDDEN'`, so every
  prior call site — e.g. the shill-bidding check — is unaffected) so the
  frontend can distinguish `EMAIL_NOT_VERIFIED` from a plain 403 and show
  a "resend" CTA instead of a generic error.
- `PublicUser` (both backend `toPublicUser` and the frontend Zustand store)
  gained `emailVerifiedAt: Date | null` — a public, non-secret fact about
  an account, safe to expose the same way `status` already is.

## Revisit Conditions

- If Gmail's sending cap becomes a real constraint (or this ever needs
  actual deliverability guarantees), swap `GmailEmailSender` for a
  dedicated transactional provider (Resend/SES/Postmark) — contained to
  one class, per `sender.ts`'s own existing doc comment; nothing else
  depends on Gmail specifics.
- If a third write path needs the same gate, consider extracting a small
  shared `assertEmailVerified(userId)` helper rather than a third hand-
  written check — two instances was arguably still fine to hand-write;
  three would be the actual "don't repeat yourself" threshold.
- If this platform ever has a compliance/trust reason to require hard
  verification (e.g. before it can process real payments at all), revisit
  the soft-vs-hard decision explicitly rather than silently tightening it.
