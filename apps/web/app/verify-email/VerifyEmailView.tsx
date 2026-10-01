'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/apiClient';
import { refreshRequest, verifyEmailRequest } from '@/lib/auth';
import { useAuthStore } from '@/store/authStore';
import { ButtonLink } from '../components/ui/Button';
import { Notice } from '../components/ui/Notice';
import { PageMessage } from '../components/ui/Page';

type State = 'verifying' | 'success' | 'error' | 'missing-token';

export function VerifyEmailView() {
  const token = useSearchParams().get('token');
  const setSession = useAuthStore((state) => state.setSession);
  const accessToken = useAuthStore((state) => state.accessToken);
  const [state, setState] = useState<State>(token ? 'verifying' : 'missing-token');
  const [errorMessage, setErrorMessage] = useState('');
  // Same Strict-Mode-double-invoke guard as app/providers.tsx's
  // SilentRefresh, and for a related reason: the verification token is
  // single-use (services/api's completeEmailVerification marks it used
  // atomically), so a second call with the SAME token would legitimately
  // fail as "already used" even though the first call actually succeeded —
  // this must only ever fire once per page load.
  const hasStarted = useRef(false);

  useEffect(() => {
    if (!token || hasStarted.current) return;
    hasStarted.current = true;

    verifyEmailRequest(token)
      .then(async () => {
        setState('success');
        // Best-effort: if this browser is already logged in as the
        // now-verified user (the common case — verifying right after
        // registering, same device), refresh the session so the
        // "verify your email" banner disappears immediately instead of
        // waiting for the next silent refresh or manual login. If it's a
        // different browser/device, refreshRequest simply fails (no cookie
        // to present) and is silently ignored — verification itself still
        // succeeded regardless.
        if (accessToken) {
          try {
            const session = await refreshRequest();
            setSession(session.user, session.accessToken);
          } catch {
            // Not logged in here, or session already gone — fine either way.
          }
        }
      })
      .catch((err: unknown) => {
        setState('error');
        setErrorMessage(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      });
  }, [token, accessToken, setSession]);

  if (state === 'missing-token') {
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-16">
        <PageMessage
          title="This link is missing its token"
          body="Check the link from your email, or request a new one from your account."
          action={<ButtonLink href="/login">Log in</ButtonLink>}
        />
      </main>
    );
  }

  if (state === 'verifying') {
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-16" aria-busy="true">
        <PageMessage title="Verifying your email…" body="This will just take a moment." />
      </main>
    );
  }

  if (state === 'error') {
    return (
      <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-16">
        <Notice tone="error">{errorMessage}</Notice>
        <p className="mt-4 text-sm text-ink/70">
          Links expire after 24 hours. If you&apos;re logged in, you can request a new one from the
          verification banner on any page.
        </p>
        <ButtonLink href="/login" className="mt-4">
          Log in
        </ButtonLink>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-16">
      <Notice tone="success">Your email is verified. You can now sell items and place bids.</Notice>
      <div className="mt-4 flex gap-3">
        <ButtonLink href="/auctions">Browse auctions</ButtonLink>
        <ButtonLink href="/auctions/new" variant="secondary">
          Sell something
        </ButtonLink>
      </div>
    </main>
  );
}
