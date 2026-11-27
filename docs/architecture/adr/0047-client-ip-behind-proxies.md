# 0047 — Finding the client's IP behind proxies

## Context

IP-keyed rate limits (ADR-0004 onward) were written and tested where the API is
reached directly. In production, Cloudflare and Render sit in front of it.

## Problem

Express was never told to trust a proxy, so `req.ip` was a proxy's address.
Visitors shared counters: with 10 sign-in attempts per 15 minutes, and token
refresh drawing on the same budget, a user signing in for the first time could
be told the rate limit was reached.

## Options Considered

1. **`trust proxy: true`** — one line, but believes the client's own
   `X-Forwarded-For`, so anyone can dodge every IP limit.
2. **A hop count** — safe when right, but the number depends on the host's
   chain, which is not under our control and fails silently when wrong.
3. **Cloudflare's `CF-Connecting-IP` header** — simple, but only safe if no
   request can ever reach the app without passing through Cloudflare.
4. **A list of trusted proxy addresses** — Express stops at the first address
   it does not trust. Independent of the number of hops.

## Decision

- Option 4: private ranges plus Cloudflare's published ranges
  (`config/trustedProxies.ts`). No environment variable to set.
- Token refresh gets its own limit (120 per 15 minutes per IP).
- The listing assistant gets a per-IP limit (20 per hour) between its per-user
  and whole-site limits.
- Request logs carry `clientIp` so the result can be checked in production.

## Tradeoffs

- Cloudflare's list is copied into the code. If it changes, some visitors are
  counted by a Cloudflare address until it is updated.
- Someone calling the API from Cloudflare's own network (for example a Worker)
  arrives from a trusted address and could forge the header.
- A host whose internal proxies use other public addresses would need them
  added.
- People behind one NAT still share an IP budget.

## Revisit Conditions

- `clientIp` in production logs shows a proxy address.
- The API moves to a host with a different proxy chain.
