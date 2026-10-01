import type { RefreshToken, User, UserStatus } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';

export type NewUser = {
  email: string;
  passwordHash: string;
  name: string;
};

// Throws Prisma's raw error on conflict (P2002) — the service layer decides
// what that means for the business, this layer only talks to the database.
export function createUser(data: NewUser): Promise<User> {
  return prisma.user.create({ data });
}

export function findUserByEmail(email: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { email } });
}

export function findUserById(id: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { id } });
}

// Throws Prisma's P2025 ("record not found") if userId doesn't exist — the
// service layer translates that, same pattern as createUser's P2002.
export function updateUserStatus(userId: string, status: UserStatus): Promise<User> {
  return prisma.user.update({ where: { id: userId }, data: { status } });
}

export type NewRefreshToken = {
  userId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  userAgent?: string;
  ip?: string;
};

export function createRefreshToken(data: NewRefreshToken) {
  return prisma.refreshToken.create({ data });
}

export function findRefreshTokenByHash(tokenHash: string) {
  return prisma.refreshToken.findUnique({ where: { tokenHash } });
}

export function revokeRefreshToken(id: string, replacedByTokenId?: string) {
  return prisma.refreshToken.update({
    where: { id },
    data: { revokedAt: new Date(), ...(replacedByTokenId ? { replacedByTokenId } : {}) },
  });
}

export type NewRotatedTokenData = {
  tokenHash: string;
  expiresAt: Date;
  userAgent?: string;
  ip?: string;
};

export type ConsumeRefreshTokenResult =
  | { kind: 'not_found' }
  | { kind: 'reused' }
  | { kind: 'expired' }
  | { kind: 'account_disabled' }
  | { kind: 'rotated'; user: User; newToken: RefreshToken };

type LockedRefreshTokenRow = {
  id: string;
  userId: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
};

// The entire check-then-act refresh sequence as ONE transaction, with the
// presented token's row locked for its duration (same shape of fix as
// ADR-0012's bid placement: `SELECT ... FOR UPDATE`, not a separate read
// followed by a separate write).
//
// Without this lock, two concurrent requests presenting the same
// pre-rotation token could both read `revokedAt: null` before either
// commits, and both would go on to successfully create a child token and
// revoke the same parent — silently forking one token into two live,
// undetected sessions (worse than the "second request gets logged out"
// behavior that was actually observed once in testing, which only happened
// because of incidental timing — see ADR-0019). Locking makes the outcome
// deterministic: whichever request loses the race for the lock re-reads
// this row AFTER the winner's write is visible, so it always sees
// `revokedAt` already set and takes the reuse-detection path — the same
// accepted false-positive ADR-0004 already documents for a legitimate
// lost-response retry, now guaranteed rather than timing-dependent.
export async function consumeRefreshToken(
  tokenHash: string,
  newTokenData: NewRotatedTokenData,
): Promise<ConsumeRefreshTokenResult> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<LockedRefreshTokenRow[]>`
      SELECT id, "userId", "familyId", "expiresAt", "revokedAt"
      FROM refresh_tokens
      WHERE "tokenHash" = ${tokenHash}
      FOR UPDATE
    `;
    const existing = rows[0];
    if (!existing) {
      return { kind: 'not_found' };
    }

    if (existing.revokedAt) {
      // O(1) regardless of chain length — see the schema comment on
      // `familyId`.
      await tx.refreshToken.updateMany({
        where: { familyId: existing.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return { kind: 'reused' };
    }

    if (existing.expiresAt < new Date()) {
      return { kind: 'expired' };
    }

    // Checked inside the same locked transaction as the rotation itself so
    // a disabled account never gets a fresh token pair, even under
    // concurrent refresh attempts — not for a locking reason (User isn't
    // the contended row here), just so this whole decision is made from one
    // consistent snapshot.
    const user = await tx.user.findUnique({ where: { id: existing.userId } });
    if (!user || user.status !== 'ACTIVE') {
      return { kind: 'account_disabled' };
    }

    const newToken = await tx.refreshToken.create({
      data: {
        userId: existing.userId,
        familyId: existing.familyId,
        tokenHash: newTokenData.tokenHash,
        expiresAt: newTokenData.expiresAt,
        ...(newTokenData.userAgent ? { userAgent: newTokenData.userAgent } : {}),
        ...(newTokenData.ip ? { ip: newTokenData.ip } : {}),
      },
    });
    await tx.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date(), replacedByTokenId: newToken.id },
    });

    return { kind: 'rotated', user, newToken };
  });
}

export type NewPasswordResetToken = {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
};

export function createPasswordResetToken(data: NewPasswordResetToken) {
  return prisma.passwordResetToken.create({ data });
}

export function findPasswordResetTokenByHash(tokenHash: string) {
  return prisma.passwordResetToken.findUnique({ where: { tokenHash } });
}

export type CompletePasswordResetInput = {
  resetTokenId: string;
  userId: string;
  newPasswordHash: string;
};

// Mark-token-used + change-password + revoke-all-sessions as one atomic
// unit: a partial failure in any direction is a real problem, not just an
// inconvenience — e.g. password changed but session revocation silently
// failing would leave a possibly-compromised session alive, defeating the
// entire purpose of the reset. Uses the array-batch form of $transaction
// (not the interactive callback form used by rotateRefreshToken) because
// none of these three writes need to read another's result first — they're
// independent operations that just need to commit-or-fail together.
export function completePasswordReset(input: CompletePasswordResetInput) {
  return prisma.$transaction([
    prisma.passwordResetToken.update({
      where: { id: input.resetTokenId },
      data: { usedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: input.userId },
      data: { passwordHash: input.newPasswordHash },
    }),
    prisma.refreshToken.updateMany({
      where: { userId: input.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}

// Invalidates any still-outstanding reset token for a user before issuing a
// new one — only the most recent reset request should ever be valid (see
// schema comment on PasswordResetToken).
export function invalidateUserResetTokens(userId: string) {
  return prisma.passwordResetToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });
}

export type NewEmailVerificationToken = {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
};

export function createEmailVerificationToken(data: NewEmailVerificationToken) {
  return prisma.emailVerificationToken.create({ data });
}

export function findEmailVerificationTokenByHash(tokenHash: string) {
  return prisma.emailVerificationToken.findUnique({ where: { tokenHash } });
}

// Same reasoning as invalidateUserResetTokens: only the most recently sent
// verification link should ever be valid, so a resend doesn't leave two
// live tokens outstanding.
export function invalidateUserVerificationTokens(userId: string) {
  return prisma.emailVerificationToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });
}

export type CompleteEmailVerificationInput = {
  verificationTokenId: string;
  userId: string;
};

// Mark-token-used + set-emailVerifiedAt as one atomic unit, same "a partial
// failure here is a real problem" reasoning as completePasswordReset.
export function completeEmailVerification(input: CompleteEmailVerificationInput) {
  return prisma.$transaction([
    prisma.emailVerificationToken.update({
      where: { id: input.verificationTokenId },
      data: { usedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: input.userId },
      data: { emailVerifiedAt: new Date() },
    }),
  ]);
}
