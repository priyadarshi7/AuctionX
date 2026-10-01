import type { NextFunction, Request, Response } from 'express';
import { env } from '../../config/env';
import { ACCESS_TOKEN_TTL_SECONDS } from '../../infrastructure/security/tokens';
import { UnauthorizedError } from '../../middleware/errors';
import {
  deleteOwnAccount,
  getCurrentUser,
  loginUser,
  logoutUser,
  refreshTokens,
  registerUser,
  requestPasswordReset,
  resendVerificationEmail,
  resetPassword,
  setUserStatus,
  verifyEmail,
} from './service';
import type {
  ForgotPasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
  UpdateUserStatusInput,
  VerifyEmailInput,
} from './schema';

const REFRESH_COOKIE_NAME = 'refreshToken';
const REFRESH_COOKIE_PATH = '/api/v1/auth';

// Scoped to /api/v1/auth so it isn't sent on every API request. httpOnly
// means client-side JS (and therefore a successful XSS payload) can never
// read it. SameSite=Lax blocks it on cross-site POSTs, which is how CSRF
// against /login, /logout, /refresh would otherwise work — see ADR-0003 for
// the documented revisit condition (cross-origin frontend/backend in prod).
function setRefreshCookie(res: Response, refreshToken: string, refreshTokenExpiresAt: Date): void {
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
    expires: refreshTokenExpiresAt,
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
}

function getRefreshTokenFromCookie(req: Request): string | undefined {
  return (req.cookies as Record<string, string | undefined>)[REFRESH_COOKIE_NAME];
}

export async function register(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = req.body as RegisterInput;
    const user = await registerUser(input);
    res.status(201).json({ user });
  } catch (err) {
    next(err);
  }
}

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = req.body as LoginInput;
    const { user, accessToken, refreshToken, refreshTokenExpiresAt } = await loginUser(input, {
      ...(req.headers['user-agent'] ? { userAgent: req.headers['user-agent'] } : {}),
      ...(req.ip ? { ip: req.ip } : {}),
    });

    setRefreshCookie(res, refreshToken, refreshTokenExpiresAt);
    res.status(200).json({ user, accessToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS });
  } catch (err) {
    next(err);
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const refreshToken = getRefreshTokenFromCookie(req);
    if (!refreshToken) {
      throw new UnauthorizedError('INVALID_REFRESH_TOKEN', 'No refresh token provided');
    }

    const result = await refreshTokens(refreshToken, {
      ...(req.headers['user-agent'] ? { userAgent: req.headers['user-agent'] } : {}),
      ...(req.ip ? { ip: req.ip } : {}),
    });

    setRefreshCookie(res, result.refreshToken, result.refreshTokenExpiresAt);
    res
      .status(200)
      .json({
        user: result.user,
        accessToken: result.accessToken,
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      });
  } catch (err) {
    // Whatever went wrong — invalid, expired, or reused-and-now-revoked —
    // the cookie the client is holding is no longer good for anything, so
    // there's no reason to keep it around for a retry.
    clearRefreshCookie(res);
    next(err);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const refreshToken = getRefreshTokenFromCookie(req);
    if (refreshToken) {
      await logoutUser(refreshToken);
    }
    clearRefreshCookie(res);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function me(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      // Unreachable in practice — this route is always behind `authenticate`
      // — but narrows the type and fails loudly instead of silently if that
      // ever stops being true.
      throw new UnauthorizedError('UNAUTHENTICATED');
    }
    const user = await getCurrentUser(req.user.id);
    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
}

export async function deleteAccountHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('UNAUTHENTICATED');
    }
    await deleteOwnAccount(req.user.id);
    // Same reasoning as logout: whatever refresh cookie the client is
    // holding is for an account that no longer exists, so there's nothing
    // left for it to be useful for.
    clearRefreshCookie(res);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function updateUserStatus(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { status } = req.body as UpdateUserStatusInput;
    const user = await setUserStatus(req.params.userId as string, status);
    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
}

const GENERIC_FORGOT_PASSWORD_MESSAGE =
  'If an account with that email exists, a password reset link has been sent.';

export async function forgotPassword(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { email } = req.body as ForgotPasswordInput;
    await requestPasswordReset(email);
    // Always this exact response, whatever happened internally — see
    // requestPasswordReset's doc comment for why.
    res.status(200).json({ message: GENERIC_FORGOT_PASSWORD_MESSAGE });
  } catch (err) {
    next(err);
  }
}

export async function resetPasswordHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { token, newPassword } = req.body as ResetPasswordInput;
    await resetPassword(token, newPassword);
    res.status(200).json({ message: 'Password has been reset successfully.' });
  } catch (err) {
    next(err);
  }
}

export async function verifyEmailHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { token } = req.body as VerifyEmailInput;
    await verifyEmail(token);
    res.status(200).json({ message: 'Email verified successfully.' });
  } catch (err) {
    next(err);
  }
}

export async function resendVerificationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('UNAUTHENTICATED');
    }
    await resendVerificationEmail(req.user.id);
    res.status(200).json({ message: 'Verification email sent.' });
  } catch (err) {
    next(err);
  }
}
