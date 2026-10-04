# ADR-0044: Stripe Checkout in test mode, with refunds and a no-real-money guarantee

## Context

Payments used an in-process mock provider (ADR-0025) that "paid" by itself 300ms
after an intent was created. The seam (`PaymentProvider`) was designed for a
real provider. This is a portfolio project: it must exercise a real payment
provider end to end, and it must never take real money.

## Problem

1. How does a buyer pay without card data touching our servers?
2. How do we settle reliably when webhooks are late, duplicated, or not yet
   configured?
3. How do we make it impossible for this deployment to charge a real card?
4. A payment can land after the 48h deadline has cancelled the order (ADR-0038):
   the money was taken for an order that no longer exists.

## Options Considered

- **Stripe Checkout (hosted page)** vs **PaymentIntents + embedded card fields.**
  Embedded fields mean a frontend library, more UI and a larger PCI scope for
  no benefit here. Chosen: Checkout. The buyer is redirected; we never see a card.
- **Trust the browser's redirect back** vs **webhook-only** vs **webhook plus
  reconciliation.** The redirect proves nothing (anyone can open the URL).
  Webhook-only strands a paid order if the webhook is late, dropped, or the
  endpoint is misconfigured. Chosen: webhook as the primary path, plus a
  buyer-triggered sync that asks Stripe directly.
- **A `stripe` dependency** vs **hand-rolled HMAC.** Webhook verification
  (timestamp tolerance, constant-time compare, signature versions) is easy to
  get subtly wrong. Chosen: the official SDK, one new dependency.
- **A flag to allow live keys in production** vs **no override.** Chosen: no
  override at all.

## Decision

- `StripePaymentProvider` creates a Checkout Session (Stripe's default 24-hour
  lifetime; no time-based parameters, because Stripe rejects an idempotency-key
  repeat whose parameters differ) and returns its URL; the order page redirects
  there. Returning buyers while the session is open are sent back to the same session; an expired or paid attempt is
  settled first so a stale attempt can never wedge an order.
- **Settlement** is one function (`settlePayment`) used by webhooks and by
  reconciliation. It is idempotent (acts only on a PENDING payment) and keeps
  ADR-0038's guard (a cancelled order is never resurrected).
- **Amount tripwire.** Earlier, an event was never allowed to carry an amount.
  Now it may, and if it does it must equal our own payment record or the payment
  is NOT applied and an error is logged. Currency must also match.
- **Webhook route** `POST /api/v1/webhooks/payments/stripe`, raw body, verified
  by the active provider. Verified events we do not act on are acknowledged (200)
  so Stripe stops retrying; unverifiable ones get 400.
- **Sync** `POST /orders/:id/payment/sync` (buyer only): fetch the session from
  Stripe and settle. The order page calls it every 3s after returning from Stripe
  while the order is still pending.
- **No real money, three independent guards:**
  1. `config/env.ts` exits at boot unless `STRIPE_SECRET_KEY` starts with
     `sk_test_` or `rk_test_`; the message never echoes the key.
  2. Every Checkout Session we create or fetch must report `livemode: false`.
  3. Every webhook event must report `livemode: false`.
  Test-mode keys cannot charge a real card anyway; the guards make a
  configuration mistake fail loudly instead of quietly working. The site also
  shows a permanent "demo, no real money" banner, and the pay page shows the
  test card.
- **Refunds.** When money arrives for an order that is no longer payable, the
  service refunds it automatically, outside any database transaction (Section
  65), with the provider idempotency key `refund-{paymentId}` so a retry can
  never refund twice. `payments.refundedAt/refundRef` (additive migration
  `20261004120000_payment_refund_tracking`) record it with a guarded update.
  If the refund call fails the order stays "needs refund" and an admin can retry
  from the dashboard (`POST /admin/orders/:id/refund`, audited).
- Provider selection: Stripe when `STRIPE_SECRET_KEY` is set, otherwise the
  mock (local dev and the whole test suite). The mock gained `fetchStatus` and
  `refund` so both providers satisfy the same interface.

## Why

The hosted page removes the largest risk surface (card data). Reconciliation
turns "the webhook must work" into "the webhook is an optimisation", which
matters on a free tier with cold starts. The amount check and the guards exist
because the cost of being wrong here is money.

## Tradeoffs

- The sync call is one more request per 3 seconds from a buyer waiting on a
  return; bounded by the page staying open and the order still pending.
- Checkout accepts whatever payment methods the Stripe account enables in test
  mode (cards, possibly wallets); delayed methods are handled by the async
  events but only cards were exercised.
- The real Stripe API is not called by the automated tests (no network or
  account in CI). Signature verification, live-mode refusal, settlement,
  refunds and reconciliation are tested against a fake provider and locally
  signed events; the SDK calls themselves must be verified with real test keys
  (see PROGRESS.md).
- Refunds are full refunds only. No partial refunds, disputes, or payouts to
  sellers (there is no seller payout in this project).

## Consequences

Real provider integration with end-to-end idempotency, no card data on our
servers, and no way to configure live payments. Order cancellation after
payment now resolves itself instead of waiting for a human.

## Revisit Conditions

- Seller payouts (Stripe Connect) if this ever handled real money, which it must
  not: that would need a live-mode design, KYC and a reconciliation ledger.
- Dispute/chargeback handling, partial refunds.
- If sync polling is noticed in the rate limiter, replace with a server push
  (the WebSocket gateway already exists) once the webhook fires.
