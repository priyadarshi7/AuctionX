# 0006 — Forgot/Reset Password, Gmail SMTP Behind an EmailSender Port

## Context

Section 29 lists password reset among the core auth concepts. There was no
email-sending capability anywhere in the system before this. The developer
chose Gmail as the provider.

## Problem

Two problems, one obvious and one easy to miss. Obvious: users need a way
to recover a forgotten password without an admin's involvement. Easy to
miss: the forgot-password endpoint is the single most attractive target for
email enumeration in the entire system — more so than registration or
login — because "does this email have an account" is exactly the question
an attacker asks first, and a naive implementation (different response for
"email sent" vs "no such user") answers it directly.

## Options Considered — email delivery

1. **Gmail SMTP via nodemailer** — chosen. Zero new infrastructure cost,
   works immediately with an account the developer already has. Real,
   stated limits: ~500 emails/day on a personal account, not built for
   transactional deliverability at scale, and Gmail's ToS is written with
   human-sent mail in mind, not automated sending. None of that matters at
   this project's current stage — no real users, low volume, learning
   context.
2. **A dedicated transactional provider (Resend/SES/Postmark)** — the
   right choice once real deliverability/scale/reputation matter. Not
   worth the account setup and API integration for a stage where Gmail is
   suffient and free.

Both are implementations of the same `EmailSender` interface — nothing
outside `infrastructure/email/sender.ts` knows or cares which one is
active. Swapping later is a new class, not a rewrite (Section 61: the cost
of the "wrong" choice now is bounded by design, not hidden).

## Decision

`EmailSender` port with three implementations, selected by environment:
`GmailEmailSender` (real SMTP, dev/production when configured),
`ConsoleEmailSender` (logs instead of sending — dev fallback when Gmail
credentials are absent, loud warning at boot so the gap is visible),
`FakeEmailSender` (records messages in memory — test environment only,
exported so tests can assert on what would have been sent).

`GMAIL_USER`/`GMAIL_APP_PASSWORD` are optional env vars, same reasoning as
`REDIS_URL`: password reset is a real feature but not existential — auction
browsing/bidding must still work with zero email configured.

## Decision — enumeration safety

`POST /forgot-password` returns the byte-identical response
(`{message: "If an account with that email exists..."}`) regardless of
whether the account exists. The email is only actually sent when the
account exists — verified directly in tests via `FakeEmailSender`, not just
asserted, by checking `sent.length === 0` for a nonexistent email and
`=== 1` for a real one, sent to the SAME endpoint, in the SAME test run.

This is a stricter bar than registration's `409 EMAIL_ALREADY_REGISTERED`,
which does reveal existence. That's a deliberate, different tradeoff, not
an inconsistency: registration's leak requires an attacker to actively
attempt registration (higher friction, and arguably acceptable UX-vs-
security tradeoff most real products make), while forgot-password is
purpose-built account-recovery infrastructure and the textbook target for
automated enumeration — it gets the stricter treatment.

## Decision — session termination on reset

`resetPassword` revokes every refresh-token family for the user, not just
the one tied to whatever session triggered the reset. Rationale: the most
common real reason someone resets a password is "I think my account was
compromised" — if the reset didn't also kill an attacker's existing
session, the reset would accomplish nothing against the actual threat it
exists to address. This directly reuses the `RefreshToken.familyId`
mechanism built for reuse detection (ADR-0004) — the same "families"
concept, now triggered by password reset rather than replay.

## Decision — atomicity

Mark-token-used + change-password + revoke-all-sessions run as one
`prisma.$transaction` (`completePasswordReset`). A partial failure in any
direction is a real problem: password changed but revocation silently
failing would leave a compromised session alive, defeating the reset's
entire purpose. Uses the array-batch `$transaction` form (not the
interactive callback form `rotateRefreshToken` uses) because none of the
three writes need to read another's result first.

## Tradeoffs

```text
Gmail SMTP:
+ Zero new infrastructure, works today, free
+ Fully isolated behind EmailSender — the eventual provider swap is
  contained and cheap
- ~500/day sending cap, not built for production deliverability
- Requires a personal Google account + App Password, not a service account
- Not something to keep once there are real users at any real volume

Strict forgot-password enumeration safety:
+ Closes the most attractive account-discovery vector in the system
- Slightly worse UX than an honest "no account with that email" message
  (a deliberate, standard tradeoff — most real password-reset flows accept
  this same worse UX for the same security reason)

Revoke-all-sessions on reset:
+ Actually addresses the "I think I was compromised" scenario, not just
  the password half of it
- A legitimate user resetting their password from habit (not a compromise)
  gets logged out of every other device too — accepted; the alternative
  (leave old sessions alive) is a security hole in the exact case this
  feature exists for
```

## Consequences

- `PasswordResetToken` table added (migration
  `20260907120145_add_password_reset_tokens`) — single-use, 30 min TTL,
  SHA-256-hashed opaque token (same reasoning as refresh tokens: high
  entropy input, no brute-force space for a slow hash to defend against).
- `generateOpaqueToken`/`hashOpaqueToken` extracted as shared primitives in
  `infrastructure/security/tokens.ts`, used by both refresh tokens and
  reset tokens — the identical random+hash pattern is correctness-critical
  code, worth deduplicating even though most business logic in this
  codebase deliberately isn't (Section 82: don't over-engineer — this is
  the exception, not a contradiction, because the risk of the two
  diverging is a real security concern, not just repetition).
- `/forgot-password` gets its own two-limiter rate-limit pair (IP-keyed and
  target-email-keyed) rather than reusing `authRateLimit` — protects
  against a distinct abuse shape (email-bombing one victim from many IPs)
  that an IP-only limit doesn't address.
- **Verified live**: forgot-password against both a real and a nonexistent
  email return byte-identical responses; the dev-server log shows exactly
  one "email not sent" warning, only for the real account — confirming the
  internal behavior differs correctly even though the HTTP contract never
  reveals it.

## Revisit Conditions

- Move off Gmail SMTP the moment there's a real deployment with real users
  — not before. `EmailSender`'s existence is exactly what makes that a
  contained change.
- If email templates grow beyond one or two (verification emails, order
  confirmations, etc. — later phases), introduce a template
  engine/rendering step rather than continuing to inline HTML strings in
  the service layer.
