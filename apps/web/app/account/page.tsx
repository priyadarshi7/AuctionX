'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '@/lib/apiClient';
import { deleteAccountRequest } from '@/lib/auth';
import { useAuthStore } from '@/store/authStore';
import { useRequireAuth } from '@/lib/useRequireAuth';
import { Button } from '../components/ui/Button';
import { Notice } from '../components/ui/Notice';
import { PageHeader, PageLoading } from '../components/ui/Page';

export default function AccountPage() {
  const auth = useRequireAuth();
  const router = useRouter();
  const clearSession = useAuthStore((state) => state.clearSession);
  const [confirming, setConfirming] = useState(false);

  // Mirrors services/api's deleteOwnAccount (modules/auth/service.ts):
  // only a completely clean account (no auctions, bids, or orders, ever)
  // can actually be deleted — ADR-0007 made auctions/bids permanent
  // business records on purpose. A blocked attempt surfaces the backend's
  // own ACCOUNT_HAS_HISTORY message rather than a generic failure, so the
  // seller knows exactly what to do (e.g. delete a leftover draft first).
  const deleteAccount = useMutation({
    mutationFn: () => deleteAccountRequest(auth.accessToken!),
    onSuccess: () => {
      clearSession();
      router.replace('/');
    },
  });

  if (!auth.ready) {
    return <PageLoading />;
  }

  const { user } = auth;
  const errorMessage =
    deleteAccount.error instanceof ApiError
      ? deleteAccount.error.message
      : deleteAccount.error
        ? 'Something went wrong. Please try again.'
        : null;

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-10">
      <PageHeader title="Account" subtitle={user.email} />

      <section className="rounded-2xl border-2 border-line bg-white p-6 shadow-hard-sm">
        <h2 className="font-display text-lg font-bold text-red-700">Delete account</h2>
        <p className="mt-2 text-sm text-ink/70">
          Permanently deletes your account, along with any of your own auctions that never
          received a bid. Only blocked if you&apos;ve ever placed a bid, received a bid on one of
          your auctions, or had an order — those are kept as permanent records and can&apos;t be
          removed. If you&apos;re blocked, check{' '}
          <a href="/my-auctions" className="underline underline-offset-4">
            My auctions
          </a>{' '}
          for the reason.
        </p>

        {errorMessage && (
          <div className="mt-4">
            <Notice tone="error">{errorMessage}</Notice>
          </div>
        )}

        <div className="mt-4">
          {confirming ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">
                This can&apos;t be undone. Delete your account?
              </span>
              <Button
                variant="danger"
                size="sm"
                onClick={() => deleteAccount.mutate()}
                disabled={deleteAccount.isPending}
              >
                {deleteAccount.isPending ? 'Deleting…' : 'Yes, delete my account'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirming(false)}
                disabled={deleteAccount.isPending}
              >
                Keep my account
              </Button>
            </div>
          ) : (
            <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
              Delete my account
            </Button>
          )}
        </div>
      </section>
    </main>
  );
}
