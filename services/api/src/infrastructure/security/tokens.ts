import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { env } from '../../config/env';

// Short-lived on purpose: this is the outer bound on how long a stolen
// access token stays useful, and on how long a role/ban change takes to
// take effect for an already-issued token (Section 61 — stated plainly as
// a tradeoff, not hidden).
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Deliberately much shorter than a refresh token: a password-reset link
// sitting in an inbox is a real exposure window (forwarded emails, shared
// mailboxes, a device left unlocked) — 30 minutes bounds it tightly since
// there's no legitimate reason a reset flow takes longer than that.
export const PASSWORD_RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

export type AccessTokenPayload = {
  sub: string;
  role: Role;
};

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: ACCESS_TOKEN_TTL_SECONDS });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  // jwt.verify's return type is `string | JwtPayload` — narrowed here since
  // we only ever sign objects, never bare string payloads.
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as jwt.JwtPayload & AccessTokenPayload;
  return { sub: decoded.sub, role: decoded.role };
}

// Shared by refresh tokens and password-reset tokens: both are opaque,
// high-entropy, single-purpose secrets whose only job is to be looked up by
// hash — not JWTs, since both need real revocation (a DB lookup is
// unavoidable either way, so a self-describing token buys nothing; see
// ADR-0003). SHA-256, not Argon2id: the input is already 256 bits of random
// data, not a low-entropy human password, so there's no brute-force space
// for a slow hash to defend against — it would only add latency to every
// lookup.
export function generateOpaqueToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashOpaqueToken(token) };
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateRefreshToken(): { token: string; hash: string } {
  return generateOpaqueToken();
}

export function hashRefreshToken(token: string): string {
  return hashOpaqueToken(token);
}
