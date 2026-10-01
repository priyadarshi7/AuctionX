'use client';

import { useState } from 'react';
import { ApiError } from '@/lib/apiClient';
import { resendVerificationRequest } from '@/lib/auth';
import { useAuthStore } from '@/store/authStore';
import { Button } from './ui/Button';

// Soft gate (2026-09-30): shown on every page for a logged-in, unverified
// user — verification isn't required to browse or log in, only to sell or
// bid, but a persistent nudge here means someone finds out BEFORE they've
// filled out a whole listing form only to be blocked at the end.
export function VerificationBanner() {
  const user = useAuthStore((state) => state.user);
  const status = useAuthStore((state) => state.status);
  const accessToken = useAuthStore((state) => state.accessToken);
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  if (status !== 'authenticated' || !user || user.emailVerifiedAt || !accessToken) {
    return null;
  }

  const handleResend = async () => {
    setState('sending');
    try {
      await resendVerificationRequest(accessToken);
      setState('sent');
    } catch (err) {
      setState('error');
      setErrorMessage(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    }
  };

  return (
    <div className="border-b-2 border-line bg-yellow px-4 py-2.5">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 text-sm">
        <p className="font-semibold">
          Verify your email to sell items and place bids.{' '}
          {state === 'sent' && <span className="font-normal">Check your inbox — a new link is on its way.</span>}
          {state === 'error' && <span className="font-normal text-ink/70">{errorMessage}</span>}
        </p>
        {state !== 'sent' && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={state === 'sending'}
            onClick={handleResend}
          >
            {state === 'sending' ? 'Sending…' : 'Resend email'}
          </Button>
        )}
      </div>
    </div>
  );
}
