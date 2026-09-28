# 0003 — JWT Access Tokens + Opaque, DB-Backed Refresh Tokens

## Context

Section 29 requires: access vs refresh tokens, token expiration, rotation,
and revocation. Section 28 requires secure cookies where applicable and XSS
protection. Bidding (the eventual hot path) needs authentication to be cheap
to verify on every request (Section 64).

## Problem

Two competing needs: the access-token check that runs on (eventually) every
request must be fast and not require a DB round trip, but the system must
also be able to revoke a compromised or logged-out session — which
inherently requires checking *something* stateful.

## Options Considered

1. **Both tokens as JWTs** — fully stateless, no DB lookup for either. But
   revocation (a hard requirement) then needs a denylist checked on every
   request, which reintroduces the DB lookup this approach was meant to
   avoid — while adding the complexity of two token formats for no benefit.
2. **Both tokens opaque, DB-backed** — simplest mental model, but now every
   single authenticated request (not just refreshes) costs a DB round trip,
   which is exactly what Section 64 says to avoid on a latency-critical path.
3. **Access token = JWT (stateless), refresh token = opaque + DB-backed** —
   the hot path (verifying an access token on a normal request) costs zero
   DB calls; the cold path (refreshing, which happens once per ~15 minutes
   per user) pays the DB cost, which is a workload it can absorb.

## Decision

Access tokens are short-lived (15 min) JWTs, signed HS256, verified
statelessly. Refresh tokens are opaque 256-bit random values, stored as a
SHA-256 hash in a `RefreshToken` table, with rotation and reuse detection.

## Why

- HS256 (symmetric) over RS256 (asymmetric): this service is the only signer
  and the only verifier right now. RS256 earns its complexity when a
  *different* service needs to verify tokens without holding the signing
  secret — not before.
- The refresh token is opaque, not a JWT, because revocation already forces
  a DB lookup on every refresh — a self-describing token buys nothing extra
  and would just be another place stale claims could leak in.
- SHA-256, not Argon2id, for the *stored* refresh-token hash: Argon2id
  exists to slow down brute-forcing a low-entropy human secret. A 256-bit
  random token has no meaningful brute-force space to slow down; a slow
  hash there would only add latency to every refresh call.
- Refresh token delivery via httpOnly cookie, scoped to `/api/v1/auth`, with
  `SameSite=Lax` — unreadable by JS (mitigates XSS token theft) and not sent
  on cross-site POSTs (mitigates CSRF against login/refresh/logout) without
  a separate CSRF token mechanism.

## Tradeoffs

```text
Stateless access token:
+ Zero DB cost to verify on the hot path
+ Simple to reason about — one secret, one algorithm
- A banned/role-changed user's existing access token stays valid for up to
  15 minutes — there is no way to hard-kill it mid-flight without adding a
  DB check back into the hot path, which defeats the point
- Anyone who steals a valid access token can use it until it expires,
  independent of any later revocation action

Opaque, DB-backed refresh token with rotation:
+ Real revocation (logout, admin action) takes effect on next refresh
+ Rotation + reuse detection gives a concrete theft signal (see 0004)
- One DB round trip per refresh (acceptable: happens ~once per 15 min per
  active user, not per request)
```

## Consequences

- `RefreshToken` table added (migration `20260907085424_add_refresh_tokens`),
  owned by the `auth` module.
- `JWT_ACCESS_SECRET` is a required, fail-fast env var (min 32 chars).
- Login rejects non-`ACTIVE` accounts only *after* verifying the password —
  revealing account status before that would be its own enumeration vector.
- Login runs a real Argon2 verify against a fixed dummy hash when no user is
  found, so a nonexistent-email attempt and a wrong-password attempt take
  comparable time — otherwise the timing gap leaks which emails are
  registered.

## Revisit Conditions

- If the Next.js frontend and this API end up on different top-level
  domains in production (Section 83), `SameSite=Lax` will not send the
  refresh cookie on cross-origin `fetch()` calls at all. That will force
  either `SameSite=None` + real CSRF tokens, a same-site reverse proxy, or a
  different refresh-delivery mechanism — a deployment-phase decision, not a
  Phase 0-12 one.
- If a second service needs to verify access tokens without holding the
  signing secret, move to RS256/EdDSA with a public verification key.
- If immediate (not eventually-consistent) session termination becomes a
  hard product requirement, that needs a short-TTL denylist or a much
  shorter access-token TTL — not a redesign of this whole scheme.
