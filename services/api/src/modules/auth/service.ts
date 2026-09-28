import { randomUUID } from 'node:crypto';
import { Prisma, type Role, type User, type UserStatus } from '@prisma/client';
import { env } from '../../config/env';
import { emailSender } from '../../infrastructure/email/sender';
import { logger } from '../../infrastructure/observability/logger';
import { hashPassword, verifyPassword } from '../../infrastructure/security/password';
import {
  PASSWORD_RESET_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  generateOpaqueToken,
  generateRefreshToken,
  hashOpaqueToken,
  hashRefreshToken,
  signAccessToken,
} from '../../infrastructure/security/tokens';
import { ConflictError, NotFoundError, UnauthorizedError } from '../../middleware/errors';
import {
  completePasswordReset,
  consumeRefreshToken,
  createPasswordResetToken,
  createRefreshToken,
  createUser,
  findPasswordResetTokenByHash,
  findRefreshTokenByHash,
  findUserByEmail,
  findUserById,
  invalidateUserResetTokens,
  revokeRefreshToken,
  updateUserStatus,
} from './repository';
import type { LoginInput, RegisterInput } from './schema';

export type PublicUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  createdAt: Date;
};

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
};

export type RequestMeta = { userAgent?: string; ip?: string };

// Never let a passwordHash escape this module, even accidentally via a
// future `...user` spread — this is the one function that decides what's
// safe to send to a client.
function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
  };
}

export async function registerUser(input: RegisterInput): Promise<PublicUser> {
  const passwordHash = await hashPassword(input.password);

  try {
    const user = await createUser({ email: input.email, passwordHash, name: input.name });
    return toPublicUser(user);
  } catch (err) {
    // P2002 = Prisma's unique constraint violation. We deliberately did NOT
    // pre-check "does this email exist?" before inserting — that check
    // would race against a concurrent registration with the same email
    // (both could pass the check before either commits). Letting Postgres's
    // unique index be the single source of truth for this decision is what
    // makes it safe under concurrency.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictError(
        'EMAIL_ALREADY_REGISTERED',
        'An account with this email already exists',
      );
    }
    throw err;
  }
}

// Computed once and reused: verifying against a real Argon2 hash costs
// roughly the same whether or not the user exists, so a nonexistent-email
// login doesn't return measurably faster than a wrong-password one — that
// timing gap is exactly what would otherwise let someone enumerate
// registered emails via login response time.
const DUMMY_HASH = hashPassword('not-a-real-password-just-for-timing-safety');

// A fresh login always starts a brand-new rotation chain (Section 41 — the
// chain has to start somewhere untainted). `refreshTokens` below has its
// own issuing path via `rotateRefreshToken`, since a rotation must also
// atomically revoke the token it's replacing.
async function issueTokenPair(user: User, meta: RequestMeta): Promise<TokenPair> {
  const accessToken = signAccessToken({ sub: user.id, role: user.role });
  const { token: refreshToken, hash } = generateRefreshToken();
  const refreshTokenExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  await createRefreshToken({
    userId: user.id,
    familyId: randomUUID(),
    tokenHash: hash,
    expiresAt: refreshTokenExpiresAt,
    ...(meta.userAgent ? { userAgent: meta.userAgent } : {}),
    ...(meta.ip ? { ip: meta.ip } : {}),
  });

  return { accessToken, refreshToken, refreshTokenExpiresAt };
}

export async function loginUser(
  input: LoginInput,
  meta: RequestMeta,
): Promise<{ user: PublicUser } & TokenPair> {
  const user = await findUserByEmail(input.email);

  if (!user) {
    await verifyPassword(await DUMMY_HASH, input.password);
    throw new UnauthorizedError('INVALID_CREDENTIALS', 'Invalid email or password');
  }

  const passwordValid = await verifyPassword(user.passwordHash, input.password);
  if (!passwordValid) {
    throw new UnauthorizedError('INVALID_CREDENTIALS', 'Invalid email or password');
  }

  // Only reveal account-status info to someone who has already proven they
  // know the password — otherwise this becomes another enumeration vector.
  if (user.status !== 'ACTIVE') {
    throw new UnauthorizedError('ACCOUNT_DISABLED', 'This account is not active');
  }

  const tokens = await issueTokenPair(user, meta);
  return { user: toPublicUser(user), ...tokens };
}

export async function getCurrentUser(userId: string): Promise<PublicUser> {
  const user = await findUserById(userId);
  // The access token can outlive the user's row (e.g. deleted between
  // token issuance and this request) for up to its 15-minute lifetime —
  // treat that as "not found," not a server error.
  if (!user) {
    throw new NotFoundError('User no longer exists');
  }
  return toPublicUser(user);
}

export async function setUserStatus(userId: string, status: UserStatus): Promise<PublicUser> {
  try {
    const user = await updateUserStatus(userId, status);
    return toPublicUser(user);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      throw new NotFoundError('User not found');
    }
    throw err;
  }
}

export async function refreshTokens(
  refreshToken: string,
  meta: RequestMeta,
): Promise<{ user: PublicUser } & TokenPair> {
  const hash = hashRefreshToken(refreshToken);
  const { token: newRefreshToken, hash: newHash } = generateRefreshToken();
  const refreshTokenExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  // The read (is this token still valid?), the reuse check, and the
  // rotation itself all happen inside ONE locked transaction — see
  // `consumeRefreshToken`'s comment (and ADR-0019) for why: doing them as
  // separate steps here, like this function used to, is exactly the
  // check-then-act race that let two concurrent refreshes both succeed
  // against the same pre-rotation token.
  const result = await consumeRefreshToken(hash, {
    tokenHash: newHash,
    expiresAt: refreshTokenExpiresAt,
    ...(meta.userAgent ? { userAgent: meta.userAgent } : {}),
    ...(meta.ip ? { ip: meta.ip } : {}),
  });

  if (result.kind === 'not_found') {
    throw new UnauthorizedError('INVALID_REFRESH_TOKEN', 'Refresh token is invalid');
  }
  if (result.kind === 'reused') {
    // This token was already rotated away once. In normal operation a
    // refresh token is used exactly once — seeing it again means either a
    // client retried a lost response (rotation succeeded, client didn't see
    // it), two tabs refreshing at once, or actual theft. We can't tell
    // those apart from the request alone, so we assume the worse case and
    // kill the whole chain (see ADR-0004 for the documented tradeoff).
    throw new UnauthorizedError(
      'REFRESH_TOKEN_REUSED',
      'This refresh token has already been used; all sessions for this login have been revoked',
    );
  }
  if (result.kind === 'expired') {
    throw new UnauthorizedError('REFRESH_TOKEN_EXPIRED', 'Refresh token has expired');
  }
  if (result.kind === 'account_disabled') {
    throw new UnauthorizedError('ACCOUNT_DISABLED', 'This account is not active');
  }

  const accessToken = signAccessToken({ sub: result.user.id, role: result.user.role });

  return {
    user: toPublicUser(result.user),
    accessToken,
    refreshToken: newRefreshToken,
    refreshTokenExpiresAt,
  };
}

export async function logoutUser(refreshToken: string): Promise<void> {
  const hash = hashRefreshToken(refreshToken);
  const existing = await findRefreshTokenByHash(hash);

  // Logout is idempotent by design (Section 41): calling it on an
  // already-revoked or unrecognized token is a no-op, not an error — the
  // caller's goal ("make sure this session is dead") is already satisfied.
  if (existing && !existing.revokedAt) {
    await revokeRefreshToken(existing.id);
  }
}

// Response is identical to the caller regardless of what happens inside —
// see the controller, which always returns the same generic message. This
// is a STRICTER enumeration bar than registration's 409 gets away with:
// forgot-password is exactly the endpoint attackers target for account
// discovery, so nothing about the outcome — not the response, not (as far
// as we control it) the timing — should reveal whether the email exists.
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await findUserByEmail(email);
  if (!user) {
    return;
  }

  // Only the most recent request should ever be valid — an old, unused
  // token from a prior email is otherwise extra standing attack surface.
  await invalidateUserResetTokens(user.id);

  const { token, hash } = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS);
  await createPasswordResetToken({ userId: user.id, tokenHash: hash, expiresAt });

  const resetLink = `${env.FRONTEND_URL}/reset-password?token=${token}`;

  try {
    await emailSender.send({
      to: user.email,
      subject: 'Reset your AuctionX password',
      html: `<p>We received a request to reset your AuctionX password. This link expires in 30 minutes:</p><p><a href="${resetLink}">${resetLink}</a></p><p>If you didn't request this, you can safely ignore this email — your password will not be changed.</p>`,
    });
  } catch (err) {
    // Deliberately not rethrown: an email-delivery failure is an
    // operational concern (visible here, in logs) — surfacing it to the
    // client would itself be an enumeration signal if it ever differed
    // between "email exists but send failed" and any other outcome.
    logger.error({ err, userId: user.id }, 'Failed to send password reset email');
  }
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const hash = hashOpaqueToken(token);
  const resetToken = await findPasswordResetTokenByHash(hash);

  // Single generic error for not-found/expired/already-used — no
  // meaningful security benefit to distinguishing them here (unlike login,
  // where "no such user" vs "wrong password" is the actual enumeration
  // vector), and it keeps the response shape uniform.
  if (!resetToken || resetToken.usedAt || resetToken.expiresAt < new Date()) {
    throw new UnauthorizedError(
      'INVALID_RESET_TOKEN',
      'This password reset link is invalid or has expired',
    );
  }

  const newPasswordHash = await hashPassword(newPassword);

  await completePasswordReset({
    resetTokenId: resetToken.id,
    userId: resetToken.userId,
    newPasswordHash,
  });
}
