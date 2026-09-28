'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { refreshRequest } from '@/lib/auth';
import { useAuthStore } from '@/store/authStore';

// Runs once when the app loads: the access token lives only in memory
// (store/authStore.ts) and is gone after a hard reload, but the httpOnly
// refresh cookie survives — so this silently exchanges it for a fresh
// access token, recovering the session without the user re-entering
// credentials. A failure here (no cookie, or an expired/reused one) just
// means "not logged in," not an error to surface.
function SilentRefresh({ children }: { children: React.ReactNode }) {
  const setChecking = useAuthStore((state) => state.setChecking);
  const setSession = useAuthStore((state) => state.setSession);
  const clearSession = useAuthStore((state) => state.clearSession);
  // Guards against React's Strict Mode deliberately mounting this effect
  // twice in development. Most effects are fine to fire twice — this one
  // genuinely isn't: refresh tokens ROTATE on every use (ADR-0004), so two
  // near-simultaneous calls both present the SAME pre-rotation cookie: the
  // first rotates it successfully, the second — presenting a token that's
  // now already used — trips reuse detection and revokes the WHOLE session
  // family as a suspected-theft signal. Caught during manual testing, not
  // by inspection: a freshly-logged-in user was silently logged back out
  // with no visible error.
  //
  // This ref only prevents THIS component instance from firing twice — it
  // does NOT protect against the equivalent real-world case of two browser
  // tabs opened moments apart, which are separate page loads with no
  // shared memory to guard with. That's a genuinely distinct, still-open
  // gap in the backend's rotation logic itself (ADR-0004), not something
  // fixable from one component.
  const hasStarted = useRef(false);

  useEffect(() => {
    if (hasStarted.current) return;
    hasStarted.current = true;

    setChecking();
    refreshRequest()
      .then((session) => setSession(session.user, session.accessToken))
      .catch(() => clearSession());
  }, [setChecking, setSession, clearSession]);

  return <>{children}</>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  // useState, not a module-level singleton — a QueryClient holds an
  // in-memory cache that must not be shared across requests on the server,
  // and must survive re-renders (not be recreated on every one) on the
  // client. Constructing it lazily inside useState's initializer gives
  // both: one instance per component instance, created exactly once.
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <SilentRefresh>{children}</SilentRefresh>
    </QueryClientProvider>
  );
}
