import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/authorize';
import {
  authRateLimit,
  forgotPasswordEmailRateLimit,
  forgotPasswordIpRateLimit,
  resendVerificationRateLimit,
} from '../../middleware/rateLimit';
import { validateBody } from '../../middleware/validate';
import {
  deleteAccountHandler,
  forgotPassword,
  login,
  logout,
  me,
  refresh,
  register,
  resendVerificationHandler,
  resetPasswordHandler,
  updateUserStatus,
  verifyEmailHandler,
} from './controller';
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  updateUserStatusSchema,
  verifyEmailSchema,
} from './schema';

export const authRoutes = Router();

// authRateLimit stacks on top of the global apiRateLimit already applied in
// app.ts — these three are pre-authentication by nature (no identity to key
// by), so they need their own strict, IP-keyed ceiling regardless of the
// generous authenticated-user quota the global limiter would otherwise give
// out (Section 30: "Login: strict").
authRoutes.post('/register', authRateLimit, validateBody(registerSchema), register);
authRoutes.post('/login', authRateLimit, validateBody(loginSchema), login);
authRoutes.post('/refresh', authRateLimit, refresh);
authRoutes.post('/logout', logout);
authRoutes.get('/me', authenticate, me);
// No dedicated rate limiter — self-only, destructive-but-rare, same
// reasoning as PATCH /users/:userId/status below (the global apiRateLimit
// already applied to /api/v1/* in app.ts is enough).
authRoutes.delete('/me', authenticate, deleteAccountHandler);

authRoutes.patch(
  '/users/:userId/status',
  authenticate,
  requireRole('ADMIN'),
  validateBody(updateUserStatusSchema),
  updateUserStatus,
);

// Both rate limiters run before validation, same as the other auth routes —
// protects against payload-varying spam too, not just well-formed requests.
authRoutes.post(
  '/forgot-password',
  forgotPasswordIpRateLimit,
  forgotPasswordEmailRateLimit,
  validateBody(forgotPasswordSchema),
  forgotPassword,
);
authRoutes.post(
  '/reset-password',
  authRateLimit,
  validateBody(resetPasswordSchema),
  resetPasswordHandler,
);

authRoutes.post(
  '/verify-email',
  authRateLimit,
  validateBody(verifyEmailSchema),
  verifyEmailHandler,
);
authRoutes.post(
  '/resend-verification',
  authenticate,
  resendVerificationRateLimit,
  resendVerificationHandler,
);
