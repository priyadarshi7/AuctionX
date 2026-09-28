import { z } from 'zod';
import { UserStatus } from '@prisma/client';

// Deliberately no forced composition rules (uppercase+digit+symbol, etc.) —
// NIST SP 800-63B recommends against them; they push users toward
// predictable patterns ("Password1!") without meaningfully raising entropy.
// A minimum length is the rule that actually matters.
export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
  name: z.string().trim().min(1).max(100),
});

export type RegisterInput = z.infer<typeof registerSchema>;

// No length/complexity constraints on login password — those belong at
// registration time. A login attempt should only ever fail because the
// credentials are wrong, not because Zod rejected a password that was
// somehow valid when it was set (e.g. an old, since-loosened min length).
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const updateUserStatusSchema = z.object({
  status: z.nativeEnum(UserStatus),
});

export type UpdateUserStatusInput = z.infer<typeof updateUserStatusSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
