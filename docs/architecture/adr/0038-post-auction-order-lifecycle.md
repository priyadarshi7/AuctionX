# ADR-0038: Post-auction order lifecycle (shipping, delivery, payment deadline)

## Context

An auction that sells creates an `Order` (ADR-0023), the buyer pays through
the payment provider (ADR-0025), and the order becomes `PAID`. Then nothing:
no way to ship, no confirmation of delivery, and a winner who never pays
leaves the order — and the seller — hanging forever.

## Problem

1. After payment the seller has no way to record that the item shipped, and
   the buyer has no tracking info or way to confirm receipt.
2. An unpaid order never expires.
3. A payment can land on an order that has meanwhile been cancelled.

## Options Considered

- **Separate `Shipment` table** vs **fields on `Order`.** One order has at
  most one shipment today; a table adds a join and a second state machine
  for no benefit yet.
- **New `order-events` Kafka topic** vs **reuse an existing one.** Aiven's
  free tier caps topics at 5 and all 5 are in use (ADR-0036).
- **Lazy expiry** (cancel on next read) vs **a worker.** Lazy expiry never
  notifies anyone and never runs for an order nobody opens.
- **Auto-confirm delivery after N days.** Deliberately not built (see
  Revisit Conditions).

## Decision

- `OrderStatus` gains `SHIPPED` and `DELIVERED`. Detail fields live on
  `Order` (`paymentDueAt`, `shippedAt`, `carrier`, `trackingNumber`,
  `deliveredAt`, `cancelledAt`, `cancelReason`); `status` stays the single
  source of truth for which state the order is in.
- State machine: `PENDING_PAYMENT → PAID → SHIPPED → DELIVERED`, with
  `PENDING_PAYMENT → CANCELLED` (payment timeout; `ADMIN` reason reserved for
  admin moderation). Seller ships (`POST /orders/:id/ship`, carrier and
  tracking number required), buyer confirms (`POST /orders/:id/confirm-delivery`).
- **Transitions are guarded UPDATEs**, not read-then-write:
  `UPDATE ... WHERE id = ? AND status = 'PAID'`. Postgres re-evaluates the
  WHERE against the committed row, so two concurrent identical requests can
  never both transition, and no explicit lock is needed. A repeat of the exact
  same request returns success (idempotent, Section 11); different shipping
  details on an already-shipped order is a 409.
- **Events via the outbox on the existing `payment-events` topic**, keyed by
  `orderId` so a given order's events stay ordered: `order.shipped`,
  `order.delivered`, `order.cancelled`. The notifications consumer turns them
  into `ORDER_SHIPPED` (buyer, plus an email with HTML-escaped tracking text),
  `ORDER_DELIVERED` (seller), and `ORDER_CANCELLED` (both).
- **Payment deadline:** 48h from order creation. A worker
  (`orderPaymentDeadlineWorker`, 60s scan) cancels overdue unpaid orders with
  the same guarded-UPDATE pattern, so multiple instances are safe. It skips an
  order that has a `PENDING` payment attempt younger than 1h (the webhook may
  be about to land); an older still-pending attempt is treated as abandoned.
- **Resurrection guard:** the payment webhook now marks an order `PAID` only if
  it is still `PENDING_PAYMENT`. If the payment succeeded for an order that is
  already cancelled, the `Payment` still records `SUCCEEDED` (the money really
  moved), no `payment.succeeded` event is emitted, and an error is logged for
  a manual refund.
- Migration backfills existing unpaid orders with a fresh 48h window from the
  migration time, so deploying it cannot instantly cancel orders that are
  already overdue under the new rule.

## Why

Guarded updates give correct concurrency for single-row state transitions
with no extra locking and no long-held row locks. Reusing the outbox and the
existing topic keeps every state change atomic with its event (Section 16)
without new infrastructure.

## Tradeoffs

- The `payment-events` topic now carries non-payment events, a misnomer
  accepted to stay within the 5-topic limit.
- A payment attempt created in the instant between the deadline worker's
  UPDATE and the buyer's pay request completing can still attach to a
  cancelled order. It is handled safely (never resurrected, logged for refund),
  but it needs a human to refund; there is no automatic refund yet.
- The seller can enter any carrier/tracking text; the server does not verify
  it against a carrier. Correcting a typo'd tracking number is not supported.
- Money stays with the platform's payment provider until a refund is issued by
  hand; there is no payout or escrow-release step (the mock provider has none).

## Consequences

Orders now have a complete, observable lifecycle with notifications at each
step; an abandoned sale resolves itself in 48h and tells both parties.

## Revisit Conditions

- Auto-confirm delivery after N days (and/or an admin override) if buyers
  forget to confirm. Needs a product decision on the grace period.
- Disputes/returns, once there is an admin tool to arbitrate them (ADMIN-003).
- Automatic refunds when real Stripe replaces the mock provider; the
  paid-but-cancelled case should then refund instead of just logging.
- A real `order-events` topic if the topic cap stops being a constraint.
- Relisting an unsold item from a cancelled order (currently the seller
  creates a new auction by hand).
