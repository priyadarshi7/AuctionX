# 0025 — Payment domain, provider port, mock provider

## Context

ADR-0023 closed the `Auction End -> Winner -> Order` half of Section 19's
flow. This closes the rest: `Order -> Payment Intent -> Provider ->
Webhook -> Verify -> Update Payment -> Update Order`.

## Problem

An Order sitting at `PENDING_PAYMENT` needs a way for the buyer to actually
pay it, and a way for that payment's outcome — decided by something
outside this system — to come back and update our records. Section 19 is
explicit that this must never trust the frontend's word for it ("frontend
says payment succeeded" is called out directly as untrustworthy); the
payment provider's own, verified confirmation is the only thing allowed to
mark an Order `PAID`.

## Options considered

**Which payment provider?**

- *Wire up real Stripe (test mode) now.* Rejected for this task, not
  forever: Stripe's test mode is free, but it requires the developer to
  create an account and generate keys themselves — this project's
  established pattern (Cloudinary rejected for object storage/MEDIA-001,
  LocalStack rejected for the same reason, Gmail chosen specifically
  because SMTP needs no separate account) is that **local development must
  never require a live third-party account**. A real provider is still the
  eventual target; see "Revisit conditions" below.
- **A `PaymentProvider` interface + a `MockPaymentProvider` implementation
  that requires zero external account. Chosen.** Exactly the same pattern
  as `infrastructure/email/sender.ts`'s `EmailSender` (`GmailEmailSender`
  vs. `ConsoleEmailSender` vs. `FakeEmailSender`, AUTH-007/ADR-0006):
  business logic depends only on the interface
  (`infrastructure/payments/provider.ts`), so a future
  `StripePaymentProvider` is a new file behind that interface, not a
  rewrite of `modules/orders`/`modules/payments`.

**How does the Mock provider simulate an async, webhook-driven flow
without a real network?**

`MockPaymentProvider.createPaymentIntent` (`infrastructure/payments/
mockProvider.ts`) returns `PENDING` immediately, then schedules a delivery
300ms later — deliberately asynchronous, because Section 19's flow is
never "payment resolves inline with the request that started it."

That delivery calls an in-process `webhookHandler` function rather than
making a real HTTP request back into this same server. This is a
documented, deliberate shortcut: a real provider genuinely crosses the
network; this doesn't. What actually matters for learning this pattern —
raw-body HMAC signature verification (Section 28: never `===` compare a
signature; `crypto.timingSafeEqual` is used) and idempotent event
processing — is fully real either way, because `webhookHandler` is set
(`modules/payments/service.ts`, module-load time) to
`handlePaymentWebhook`, the EXACT function the real HTTP webhook route
(`POST /api/v1/webhooks/payments/mock`) also calls. Only the literal
network hop is skipped, to avoid this infrastructure-layer class needing
to know its own server's port/base URL, and to keep tests deterministic
without binding a second real listener.

This also required a real dependency-direction decision:
`MockPaymentProvider` is infrastructure-layer and must not statically
import `modules/payments/service.ts` (a domain module) — that would
violate the same layering discipline as every other module (Section 54).
Instead, `setWebhookHandler()` is a runtime injection point;
`modules/payments/service.ts` wires itself in at module load. No import
cycle, but the two pieces are runtime-coupled — documented in both files.

**How is the webhook's raw body preserved through Express?**

`app.use('/api/v1/webhooks/payments', paymentWebhookRoutes)` is mounted in
`app.ts` **before** `express.json()`, and the route itself applies
`express.raw({ type: '*/*' })`. Signature verification needs the *exact
bytes* the provider signed — if this route ran after `express.json()`, the
body would already be a parsed object, and nothing about it would still
match what was signed. This is the same requirement a real Stripe
integration has (their SDK examples always mount the webhook route ahead
of any JSON body parser).

**How is "pay this order" made idempotent, given the call crosses an
external system?**

`Bid`'s idempotency (ADR-0011/0012) holds one Postgres row lock across its
entire operation, because everything involved is local Postgres math.
Payment can't do that — Section 65 says never hold a lock across a call to
an external system, and even though `MockPaymentProvider`'s call happens
to be in-process today, the design has to hold for a real provider too.

So `createPaymentIntentForOrder` (`modules/payments/service.ts`) does NOT
lock anything across the provider call. Instead:

1. A cheap, unlocked check (`findActivePaymentForOrder`) catches the
   common case — an already-in-flight or already-succeeded payment — before
   ever calling the provider.
2. The provider is called with a caller-generated `idempotencyKey`
   (Section 11 — matches `Bid`'s body-field pattern, not a header).
   `MockPaymentProvider` itself dedupes on this key (a small in-memory map)
   — mirroring how a real provider like Stripe behaves when you pass it an
   idempotency key: a retried call with the same key gets back the *same*
   object, not a new one.
3. `Payment.@@unique([orderId, idempotencyKey])` is the actual race-breaker
   for the rare case where two concurrent requests both pass step 1 before
   either commits: both optimistically insert, the loser gets a Postgres
   unique-constraint violation (`P2002`), caught and treated as "fetch and
   return the winner's row" — the exact same pattern `bids/service.ts`
   already uses for its own cross-auction idempotency-key race.

## Decision

- `infrastructure/payments/provider.ts` — the `PaymentProvider` interface.
  `PaymentWebhookEvent` deliberately carries only `{type, providerRef}`,
  never an amount — there is nothing in a webhook payload to even
  accidentally trust for money (Section 19); the amount that gets marked
  paid always comes from the `Payment` row we created ourselves.
- `infrastructure/payments/mockProvider.ts` — `MockPaymentProvider`, the
  only implementation wired up today (`infrastructure/payments/index.ts`).
- `modules/payments/` — `createPaymentIntentForOrder`,
  `handlePaymentWebhook`, the webhook HTTP route.
- `modules/orders/` — `GET /api/v1/orders` (mine, as buyer or seller),
  `GET /api/v1/orders/:id`, `POST /api/v1/orders/:id/pay`.
- `WebhookVerificationError` (400, `INVALID_WEBHOOK`) added to
  `middleware/errors.ts` for a failed/missing signature — distinct from
  `UnauthorizedError`, since this isn't a caller-identity problem, it's an
  unverifiable request.
- A duplicate/unrecognized webhook delivery is a **silent, logged no-op**
  (`applyPaymentWebhookEvent` returns `{applied: false}`, still responds
  `200`) — real providers retry webhooks they can't confirm receipt of
  (Section 41); responding with an error would just trigger more retries
  for something that already succeeded or never was ours.

## Tradeoffs

- MockPaymentProvider's webhook delivery skips the actual network hop
  (see above) — documented as a deliberate simplification, not hidden.
- No `StripePaymentProvider` exists yet — Section 19's flow is fully
  implemented and testable end-to-end against the mock, but nothing has
  been verified against a real provider's actual signature format/API
  shape yet. That verification only happens when Stripe is actually wired
  in.
- `Order.status` is the only externally-visible payment state on the order
  itself (`PENDING_PAYMENT | PAID | CANCELLED`) — a buyer/seller sees
  individual `Payment` attempts (including a `FAILED` one) only via
  `GET /api/v1/orders/:id`'s nested data if the frontend chooses to fetch
  it; there's no separate "payment history" endpoint yet, since nothing
  needs one beyond what this gives.

## Consequences

- 155/155 tests passing (146 prior + 9 new: order visibility/ownership,
  full pay -> webhook -> PAID flow with a real ~300ms wait — same
  "test real async behavior with a short real wait" precedent as
  `auctions/closing.test.ts` — concurrent double-pay idempotency,
  already-PAID rejection, and direct webhook-endpoint tests for missing/
  wrong signature, unknown `providerRef`, and duplicate delivery).
- Found and fixed while writing the webhook tests: supertest/superagent
  JSON.stringifies a `Buffer` payload (`{"type":"Buffer","data":[...]}`)
  when told `Content-Type: application/json`, silently breaking any
  byte-exact signature test — confirmed by comparing a real `curl` request
  (worked) against supertest (didn't) and diffing what the server actually
  received. Fixed by using `application/octet-stream` in the test client
  only; the real route's `express.raw({ type: '*/*' })` was never the
  problem. Documented inline in the test file so this doesn't get
  rediscovered the hard way again.

## Revisit conditions

- Add `StripePaymentProvider` once there's an actual reason to accept real
  money (a real deployment, Phase 13+) — selected by env, same as
  `GmailEmailSender` is today, not replacing `MockPaymentProvider` (local
  dev should keep working with zero account required).
- If a buyer-facing "payment history/receipts" view is ever needed beyond
  what `GET /api/v1/orders/:id` already returns, add a dedicated endpoint
  then, not speculatively now.
