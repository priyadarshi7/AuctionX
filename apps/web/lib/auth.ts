import { apiFetch } from './apiClient';
import type { PublicUser } from '@/store/authStore';
import type { LoginFormValues, RegisterFormValues } from './validation/auth';

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
