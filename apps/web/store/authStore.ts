import { create } from 'zustand';

export type PublicUser = {
  id: string;
  email: string;
  name: string;
  role: 'USER' | 'ADMIN';
  status: 'ACTIVE' | 'SUSPENDED' | 'BANNED';
  // null = unverified. Soft gate (2026-09-30): browsing/login never require
  // this, but selling and bidding do (services/api's createNewAuction /
  // placeBid) — components that show a "verify your email" nudge key off
  // this being null, not off `status`, which is unrelated.
  emailVerifiedAt: string | null;
  createdAt: string;
};

type AuthStatus = 'idle' | 'checking' | 'authenticated' | 'anonymous';

type AuthState = {
  user: PublicUser | null;
  // Never persisted to localStorage/sessionStorage (Section 28/29 — XSS:
  // anything in Web Storage is readable by any script running on the page,
  // including an injected one). Living only in memory means it's lost on a
  // hard reload, which is why app/providers.tsx silently calls
  // POST /auth/refresh once on mount to recover it from the httpOnly
  // refresh cookie — the same "silent refresh" concept flagged back in
  // AUTH-003's TOKEN_EXPIRED/INVALID_TOKEN distinction.
  accessToken: string | null;
  // Distinguishes "haven't checked yet" from "checked, and you're logged
  // out" — without this, every page load would flash a logged-out UI for a
  // moment while the silent-refresh request is still in flight.
  status: AuthStatus;
  setChecking: () => void;
  setSession: (user: PublicUser, accessToken: string) => void;
  clearSession: () => void;
};

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  accessToken: null,
  status: 'idle',
  setChecking: () => set({ status: 'checking' }),
  setSession: (user, accessToken) => set({ user, accessToken, status: 'authenticated' }),
  clearSession: () => set({ user: null, accessToken: null, status: 'anonymous' }),
}));
