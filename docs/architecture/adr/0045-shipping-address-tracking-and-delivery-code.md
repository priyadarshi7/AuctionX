# ADR-0045: Shipping address, tracking timeline and OTP delivery confirmation

## Context

After payment the flow was thin: the order had no delivery address (the seller
could not know where to send anything), "tracking" was a carrier and number the
seller typed in and nothing checked, and the buyer ended an order by clicking
"I received it" whenever they liked.

## Problem

1. A seller needs a destination, and the address is personal data.
2. Tracking should be something the platform produces and the buyer can watch,
   not free text.
3. Delivery should be proven by an act of handover, not a self-declared click:
   the buyer clicking proves nothing, a buyer who never clicks strands the order
   forever, and a dishonest party can lie either way.
4. There are no real parcels, so tracking events have to be simulated honestly.

## Options Considered

- **Address:** Stripe Checkout's address collection vs our own form. Chosen: our
  own form, before payment, validated and stored on the order, so it does not
  depend on the payment provider.
- **Tracking:** keep typed text; integrate a real aggregator now (EasyPost,
  Shippo, AfterShip); or a provider seam with a simulated courier. A real
  aggregator still needs real parcels or its test mode, plus an account. Chosen:
  the seam plus a simulated courier, so a real provider can be dropped in later.
- **Delivery proof:** buyer click (status quo); a code the buyer holds and the
  seller enters; or a signature/photo. Chosen: the code, the model used by large
  e-commerce delivery.
- **Storing the code:** plaintext, a hash, or derive it. A hash cannot be shown
  to the buyer again. Chosen: derive it.

## Decision

- **Address.** `orders.shippingAddress` (validated JSON, ISO country code,
  phone, no control characters). The buyer must save one before paying
  (`SHIPPING_ADDRESS_REQUIRED`) and can change it until the order ships. Visible
  to the buyer; to the seller only while the order is PAID or SHIPPED; never to
  anyone else, not in lists, and not to admins.
- **Shipping.** "Mark as shipped" takes no input. A `ShippingProvider` assigns
  the carrier and tracking number, deterministically per order (a retry yields
  the same number). The only implementation is a labelled demo courier.
- **Tracking.** `shipment_events` (LABEL_CREATED, IN_TRANSIT, OUT_FOR_DELIVERY,
  DELIVERED), unique per `(order, type)`. A worker advances a shipment one step
  every `SHIPPING_SIM_STEP_SECONDS` (30s). It never creates DELIVERED. A real
  provider would write the same rows from its webhook.
- **Delivery code.** A 6-digit code = HMAC-SHA256 over `orderId:version` with a
  key domain-separated from JWT use of the secret. Nothing is stored except an
  integer version and an attempt counter. The buyer sees it on the order page of
  a SHIPPED order and in the shipped email; the seller enters it to mark the order
  DELIVERED (`deliveredVia = OTP`). The old buyer-click endpoint is gone.
- **Brute force.** Six digits is about 20 bits, so safety is the attempt cap, not
  entropy: each guess is counted first in a guarded UPDATE that only matches
  while attempts remain, so simultaneous guesses cannot exceed 5 (tested with 12
  at once). After 5 the order is locked and even the right code is refused until
  the BUYER regenerates (version + 1, attempts reset). The seller cannot.
- **Fallback.** An hourly worker auto-confirms an order that has been SHIPPED for
  `ORDER_AUTO_CONFIRM_DAYS` (7), `deliveredVia = AUTO`, so a lost code or a
  silent buyer cannot strand an order. Both parties are notified either way.

## Why

The code turns delivery from a claim into a shared secret that only the person
at the door holds. Deriving it avoids a secret-at-rest and lets the buyer see it
again after a page reload. The provider seam keeps the demo honest (the carrier
name says "demo") while leaving the real integration a drop-in.

## Tradeoffs

- With simulated parcels, the seller (not a courier) types the code. In real
  life a courier app would. The security argument is the same: the seller cannot
  complete delivery without the buyer's code.
- A seller who already holds the money-equivalent has an incentive to guess, and
  a buyer who is given a code but refuses to share it blocks completion. The
  7-day auto-confirm resolves it in the SELLER's favour; there is no dispute flow
  yet (the buyer cannot contest an auto-confirmed order).
- The code is emailed to the buyer, so email security matters. It is only useful
  to someone who is also the seller entering it.
- The code can be shown from the moment the order ships, not only when "out for
  delivery". Gating it on tracking would couple completion to the simulator.
- The demo courier is simulated: tracking numbers are not real and cannot be
  looked up elsewhere.
- Address is stored as JSON on the order. Fine for display and labels; not
  queryable and not normalised.

## Consequences

Orders cannot be paid without a destination, cannot ship without one, and cannot
complete without the buyer's code (or the fallback). Existing unpaid orders will
ask for an address the next time the buyer opens them. Additive migration
`20261004160000_shipping_address_tracking_delivery_otp`.

## Revisit Conditions

- A real shipping aggregator (EasyPost/Shippo/AfterShip): implement
  `ShippingProvider`, write events from its webhook, retire the simulator.
- A dispute and returns flow, including contesting an auto-confirmed delivery.
- Gate the code on OUT_FOR_DELIVERY once events come from a real provider.
- Release held funds to the seller on delivery (payouts are not modelled).
