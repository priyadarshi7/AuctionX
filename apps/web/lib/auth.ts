import { apiFetch } from './apiClient';
import type { PublicUser } from '@/store/authStore';
import type { ForgotPasswordFormValues, LoginFormValues, RegisterFormValues } from './validation/auth';

// Mirrors services/api/src/modules/auth/controller.ts's actual response
// shapes for these three endpoints.
export type AuthSession = { user: PublicUser; accessToken: string; expiresIn: number };

export function loginRequest(values: LoginFormValues): Promise<AuthSession> {
  return apiFetch<AuthSession>('/auth/login', { method: 'POST', body: values });
}

export function registerRequest(values: RegisterFormValues): Promise<{ user: PublicUser }> {
  return apiFetch<{ user: PublicUser }>('/auth/register', { method: 'POST', body: values });
}

// No accessToken argument — the refresh cookie (httpOnly, sent via
// credentials: 'include' in apiClient.ts) is what authenticates this call,
// not a bearer token.
export function refreshRequest(): Promise<AuthSession> {
  return apiFetch<AuthSession>('/auth/refresh', { method: 'POST' });
}

export function logoutRequest(): Promise<void> {
  return apiFetch<void>('/auth/logout', { method: 'POST' });
}

// Mirrors services/api's deleteOwnAccount (modules/auth/service.ts) — only
// succeeds for a completely clean account (no auctions/bids/orders ever),
// and rejects with ACCOUNT_HAS_HISTORY (409) otherwise.
export function deleteAccountRequest(accessToken: string): Promise<void> {
  return apiFetch<void>('/auth/me', { method: 'DELETE', accessToken });
}

export function verifyEmailRequest(token: string): Promise<{ message: string }> {
  return apiFetch<{ message: string }>('/auth/verify-email', { method: 'POST', body: { token } });
}

export function resendVerificationRequest(accessToken: string): Promise<{ message: string }> {
  return apiFetch<{ message: string }>('/auth/resend-verification', { method: 'POST', accessToken });
}

export function forgotPasswordRequest(values: ForgotPasswordFormValues): Promise<{ message: string }> {
  return apiFetch<{ message: string }>('/auth/forgot-password', { method: 'POST', body: values });
}

export function resetPasswordRequest(token: string, newPassword: string): Promise<{ message: string }> {
  return apiFetch<{ message: string }>('/auth/reset-password', {
    method: 'POST',
    body: { token, newPassword },
  });
}
