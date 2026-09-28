# 0004 — Refresh Token Rotation with Reuse Detection

## Context

ADR-0003 established opaque, DB-backed refresh tokens specifically because
they can be revoked. Revocation is only a meaningful security control if
something actually triggers it during normal use — otherwise a stolen
refresh token remains valid for its entire 30-day lifetime, which defeats
much of the point of making it revocable at all.

## Problem

A refresh token sits in a cookie for up to 30 days. If it's ever
exfiltrated (XSS despite httpOnly via a different vector, a compromised
device, a logged network proxy), the thief has a working session for as
long as the legitimate user doesn't happen to trigger a manual logout. There
is no natural moment where the system would otherwise notice.

## Options Considered

1. **No rotation — the same refresh token is reused until it expires or the
   user logs out.** Simplest, but a stolen token is valid for up to 30 days
   with no detection mechanism at all.
2. **Rotate on every use, no reuse detection** — issue a new token each
   refresh, but don't specially handle an old token being presented again.
   Limits a stolen-but-unused token's window, but a thief who refreshes
   *before* the legitimate user notices nothing wrong.
3. **Rotate on every use, with reuse detection that revokes the entire
   rotation chain** — the same limited window as (2), plus: if the old
   (now-dead) token is ever presented again by *either* party, that is
   itself evidence of a problem, and the reaction is to kill every token
   descended from that login, forcing full re-authentication.

## Decision

Rotate the refresh token on every use. Track a `familyId` shared by every
token descended from one login. If a token presented to `/refresh` is
already marked revoked, treat that as a theft signal and revoke every
unrevoked token sharing its `familyId`.

## Why

- Rotation alone already shrinks the exploitable window from "up to 30
  days" to "until the legitimate user's next refresh" (typically ≤15
  minutes, since that's the access-token TTL forcing a refresh).
- Reuse detection turns a *theoretical* revocation capability into an
  *actual* trigger: the specific event that says "something is wrong here"
  is exactly the event that becomes structurally certain the moment two
  parties are both trying to use one rotation chain.
- `familyId`, not chain-walking via `replacedByTokenId`: revoking a
  compromised chain has to be reliable even for a long-lived, frequently
  refreshed session (a 30-day session refreshing every 15 minutes chains
  through ~2,880 tokens). A shared, indexed `familyId` makes the revocation
  a single `UPDATE ... WHERE familyId = ?` — O(1) regardless of chain
  length — instead of an unbounded walk.

## Tradeoffs

```text
+ Stolen-but-unused token's window: 30 days -> ~15 minutes
+ Theft gets an actual detection trigger, not just a theoretical revocation
  capability that nothing ever exercises
+ familyId revocation is O(1), not an unbounded chain walk
- A client that legitimately retries a refresh after a lost response (network
  blip, not theft) will trip the SAME reuse-detection path and get logged
  out — this is a real, accepted false positive, not a hidden one
- One extra column + index (familyId) and one extra DB round trip per
  refresh compared to "no rotation" (acceptable: refresh happens roughly
  once per access-token TTL per active user, not per request)
```

## Consequences

- `RefreshToken.familyId` added (migration `20260907103736_add_refresh_token_family`).
- `rotateRefreshToken` performs the create-new + revoke-old pair inside one
  `prisma.$transaction` — a partial success in either direction would either
  fail to actually rotate (security hole) or log the user out for nothing
  (availability hit with no security benefit).
- `POST /api/v1/auth/refresh` clears the refresh cookie on *any* failure
  (invalid, expired, or reused) — there's never a reason for the client to
  keep sending a cookie that's already known to be dead.
- **Verified, not just implemented**: a test simulates a 6-token-long
  rotation chain, replays the first token, and confirms both the reused
  token and the most-recently-issued token (several rotations removed) are
  both rejected — proving whole-family revocation actually works across a
  realistic chain length, not just a 2-token toy case.

## Revisit Conditions

- If real users start hitting REFRESH_TOKEN_REUSED from legitimate flaky-
  network retries often enough to be a measured support burden (not a
  hypothetical), introduce a short grace window (e.g., allow the
  immediately-previous token for a few seconds after rotation) rather than
  abandoning reuse detection outright.
- If a product requirement emerges for "show me all active sessions / let
  me revoke this one specific device," `familyId` plus `userAgent`/`ip`
  already on each row is enough to build that without a schema change.
