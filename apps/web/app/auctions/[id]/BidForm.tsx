'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ApiError } from '@/lib/apiClient';
import { resendVerificationRequest } from '@/lib/auth';
import { getBidErrorMessage } from '@/lib/bidErrors';
import type { Auction, Bid } from '@/lib/types/auction';
import { makeOptimisticBid, placeBidRequest } from '@/lib/bids';
import { formatCents } from '@/lib/format';
import { useAuthStore } from '@/store/authStore';
import { Button } from '../../components/ui/Button';
import { Field, inputClass } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';

const bidFormSchema = z.object({
  amount: z
    .string()
    .trim()
    .min(1, 'Enter a bid amount')
    .refine((value) => Number(value) > 0, 'Must be greater than 0'),
});
type BidFormValues = z.infer<typeof bidFormSchema>;

// Convenience only: these pre-fill the field with (current price + step).
// The server still decides whether any bid is valid — nothing here is
// trusted (Section 9: never trust client-controlled prices).
const QUICK_STEPS_CENTS = [100, 500, 1000];

export function BidForm({
  auctionId,
  currentPriceCents,
  accessToken,
}: {
  auctionId: string;
  currentPriceCents: number;
  accessToken: string;
}) {
  const queryClient = useQueryClient();
  const userId = useAuthStore((state) => state.user?.id);
  const [serverError, setServerError] = useState<string | null>(null);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [extended, setExtended] = useState(false);
  const [placed, setPlaced] = useState<number | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<BidFormValues>({ resolver: zodResolver(bidFormSchema) });

  const onSubmit = async (values: BidFormValues) => {
    setServerError(null);
    setNeedsVerification(false);
    setResendState('idle');
    setExtended(false);
    setPlaced(null);
    const amountCents = Math.round(Number(values.amount) * 100);
    // A fresh key per submit, not per component mount — each click is a
    // genuinely new bid attempt from the user's perspective (Section 11).
    // The submit button is disabled while a request is in flight
    // (isSubmitting below), so this can't fire twice for the SAME click.
    const idempotencyKey = crypto.randomUUID();

    // Optimistic update (ADR-0037): show the bid as placed right now instead
    // of after the ~0.8s round trip to the server. The server stays the only
    // authority — this is a guess that is replaced by the server's real data
    // on success (invalidate below) or rolled back on failure. Pending
    // fetches are cancelled first so a poll that was already in flight can't
    // land after this and overwrite the guess with stale data.
    const detailKey = ['auctions', 'detail', auctionId];
    const bidsKey = ['auctions', 'bids', auctionId];
    await Promise.all([queryClient.cancelQueries({ queryKey: detailKey }), queryClient.cancelQueries({ queryKey: bidsKey })]);
    const previousDetails = queryClient.getQueriesData<{ auction: Auction }>({ queryKey: detailKey });
    const previousBids = queryClient.getQueriesData<{ bids: Bid[] }>({ queryKey: bidsKey });
    queryClient.setQueriesData<{ auction: Auction }>({ queryKey: detailKey }, (old) =>
      old ? { ...old, auction: { ...old.auction, currentPriceCents: amountCents } } : old,
    );
    if (userId) {
      const optimistic = makeOptimisticBid(auctionId, userId, amountCents, idempotencyKey);
      queryClient.setQueriesData<{ bids: Bid[] }>({ queryKey: bidsKey }, (old) =>
        old ? { ...old, bids: [optimistic, ...old.bids] } : old,
      );
    }
    reset();

    try {
      const result = await placeBidRequest(accessToken, auctionId, amountCents, idempotencyKey);
      setExtended(result.auctionExtended);
      setPlaced(amountCents);
      // Replace the guess with the server's real data (real bid id, real
      // timestamp, any other bids that landed meanwhile).
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: detailKey }),
        queryClient.invalidateQueries({ queryKey: bidsKey }),
      ]);
    } catch (err) {
      for (const [key, data] of [...previousDetails, ...previousBids]) queryClient.setQueryData(key, data);
      void queryClient.invalidateQueries({ queryKey: detailKey });
      void queryClient.invalidateQueries({ queryKey: bidsKey });
      setServerError(err instanceof ApiError ? getBidErrorMessage(err) : 'Something went wrong. Please try again.');
      setNeedsVerification(err instanceof ApiError && err.code === 'EMAIL_NOT_VERIFIED');
    }
  };

  const handleResend = async () => {
    setResendState('sending');
    try {
      await resendVerificationRequest(accessToken);
      setResendState('sent');
    } catch {
      setResendState('idle');
    }
  };

  const fillQuick = (stepCents: number) => {
    setValue('amount', ((currentPriceCents + stepCents) / 100).toFixed(2), { shouldValidate: true });
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-3">
      <Field
        label={`Your bid (more than ${formatCents(currentPriceCents)})`}
        htmlFor="amount"
        error={errors.amount?.message}
      >
        <div className="relative">
          <span aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 font-display font-bold">
            $
          </span>
          <input
            id="amount"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            aria-invalid={errors.amount ? true : undefined}
            aria-describedby={errors.amount ? 'amount-error' : undefined}
            {...register('amount')}
            className={`${inputClass(!!errors.amount)} pl-8 font-display text-lg font-bold`}
          />
        </div>
      </Field>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Quick bid amounts">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink/60">Quick</span>
        {QUICK_STEPS_CENTS.map((step) => (
          <button
            key={step}
            type="button"
            onClick={() => fillQuick(step)}
            className="rounded-full border-2 border-line bg-white px-3 py-1 text-sm font-semibold transition-colors hover:bg-yellow"
          >
            +{formatCents(step).replace('.00', '')}
          </button>
        ))}
      </div>

      <Button type="submit" disabled={isSubmitting} className="w-full">
        {isSubmitting ? 'Placing bid…' : 'Place bid'}
      </Button>

      {serverError && (
        <Notice tone="error">
          <p>{serverError}</p>
          {needsVerification && (
            <div className="mt-2">
              {resendState === 'sent' ? (
                <span className="text-sm font-semibold">Check your inbox — a new link is on its way.</span>
              ) : (
                <Button type="button" size="sm" variant="secondary" disabled={resendState === 'sending'} onClick={handleResend}>
                  {resendState === 'sending' ? 'Sending…' : 'Resend verification email'}
                </Button>
              )}
            </div>
          )}
        </Notice>
      )}
      {placed !== null && !serverError && (
        <Notice tone="success">
          Bid of {formatCents(placed)} placed.
          {extended && ' It landed in the closing seconds, so the clock was extended by 30 seconds.'}
        </Notice>
      )}
    </form>
  );
}
