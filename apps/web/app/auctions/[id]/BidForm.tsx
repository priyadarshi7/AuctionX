'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ApiError } from '@/lib/apiClient';
import { getBidErrorMessage } from '@/lib/bidErrors';
import { placeBidRequest } from '@/lib/bids';
import { formatCents } from '@/lib/format';

const bidFormSchema = z.object({
  amount: z
    .string()
    .trim()
    .min(1, 'Enter a bid amount')
    .refine((value) => Number(value) > 0, 'Must be greater than 0'),
});
type BidFormValues = z.infer<typeof bidFormSchema>;

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
  const [serverError, setServerError] = useState<string | null>(null);
  const [extended, setExtended] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<BidFormValues>({ resolver: zodResolver(bidFormSchema) });

  const onSubmit = async (values: BidFormValues) => {
    setServerError(null);
    setExtended(false);
    const amountCents = Math.round(Number(values.amount) * 100);
    // A fresh key per submit, not per component mount — each click is a
    // genuinely new bid attempt from the user's perspective (Section 11).
    // The submit button is disabled while a request is in flight
    // (isSubmitting below), so this can't fire twice for the SAME click.
    const idempotencyKey = crypto.randomUUID();

    try {
      const result = await placeBidRequest(accessToken, auctionId, amountCents, idempotencyKey);
      setExtended(result.auctionExtended);
      reset();
      // Both queries need to reflect the new bid immediately — the price
      // shown, and the history list it now appears in — rather than
      // waiting for the next poll interval (app/auctions/[id]/page.tsx).
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['auctions', 'detail', auctionId] }),
        queryClient.invalidateQueries({ queryKey: ['auctions', 'bids', auctionId] }),
      ]);
    } catch (err) {
      setServerError(err instanceof ApiError ? getBidErrorMessage(err) : 'Something went wrong. Please try again.');
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-2 rounded border border-gray-200 p-4">
      <label htmlFor="amount" className="text-sm font-medium text-gray-700">
        Your bid — must exceed {formatCents(currentPriceCents)}
      </label>
      <div className="flex gap-2">
        <input
          id="amount"
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          {...register('amount')}
          className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={isSubmitting}
          className="rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {isSubmitting ? 'Placing bid…' : 'Place bid'}
        </button>
      </div>
      {errors.amount && <p className="text-sm text-red-600">{errors.amount.message}</p>}
      {serverError && <p className="text-sm text-red-600">{serverError}</p>}
      {extended && <p className="text-sm text-green-700">Your bid extended the auction by 30 seconds!</p>}
    </form>
  );
}
