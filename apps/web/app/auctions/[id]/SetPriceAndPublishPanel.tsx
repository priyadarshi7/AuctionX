'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { ApiError } from '@/lib/apiClient';
import { publishAuctionRequest, startAuctionRequest, updateAuctionRequest } from '@/lib/auctions';
import { computeEndTime, DURATION_LABELS } from '@/lib/duration';
import { setPriceAndPublishFormSchema, type SetPriceAndPublishFormValues } from '@/lib/validation/auction';
import { Button } from '../../components/ui/Button';
import { Field, SelectField, inputClass } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';

// Seller-only, DRAFT-only — the create form (app/auctions/new/page.tsx)
// deliberately doesn't collect price, so this is where a real price is set
// for the first time, alongside (and informed by) the AI valuation panel
// shown right above this one on the same page. Publishing here does NOT
// depend on the valuation having succeeded — a FAILED or still-PENDING
// valuation never disables this form, since the valuation is a helper
// signal, not a precondition for a seller's own pricing decision.
export function SetPriceAndPublishPanel({ auctionId, accessToken }: { auctionId: string; accessToken: string }) {
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SetPriceAndPublishFormValues>({
    resolver: zodResolver(setPriceAndPublishFormSchema),
    defaultValues: { durationSeconds: '86400' },
  });

  const publish = useMutation({
    mutationFn: async (values: SetPriceAndPublishFormValues) => {
      const startingPriceCents = Math.round(Number(values.startingPrice) * 100);
      const reservePriceCents =
        values.reservePrice && values.reservePrice !== '' ? Math.round(Number(values.reservePrice) * 100) : undefined;

      await updateAuctionRequest(accessToken, auctionId, {
        startingPriceCents,
        ...(reservePriceCents !== undefined ? { reservePriceCents } : {}),
      });
      const endTime = computeEndTime(values.durationSeconds);
      await publishAuctionRequest(accessToken, auctionId, endTime);
      await startAuctionRequest(accessToken, auctionId);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['auctions', 'detail', auctionId] });
    },
  });

  const publishError = publish.error instanceof ApiError ? publish.error.message : publish.error ? 'Something went wrong.' : null;

  return (
    <div className="rounded-2xl border-2 border-line bg-white p-5 shadow-hard">
      <h2 className="font-display text-lg font-extrabold">Set your price</h2>
      <p className="mt-1 text-sm text-ink/70">
        This draft is only visible to you. Use the AI valuation above as a rough guide, set your own price, then
        publish when ready.
      </p>
      <form
        onSubmit={handleSubmit((values) => publish.mutate(values))}
        noValidate
        className="mt-4 flex flex-col gap-3"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Starting price ($)" htmlFor="startingPrice" error={errors.startingPrice?.message}>
            <input
              id="startingPrice"
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              aria-invalid={errors.startingPrice ? true : undefined}
              className={inputClass(!!errors.startingPrice)}
              {...register('startingPrice')}
            />
          </Field>
          <Field
            label="Reserve price ($, optional)"
            htmlFor="reservePrice"
            hint="The lowest price you'll accept."
            error={errors.reservePrice?.message}
          >
            <input
              id="reservePrice"
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              aria-invalid={errors.reservePrice ? true : undefined}
              className={inputClass(!!errors.reservePrice)}
              {...register('reservePrice')}
            />
          </Field>
        </div>
        <SelectField id="durationSeconds" label="Duration" error={errors.durationSeconds?.message} {...register('durationSeconds')}>
          {Object.entries(DURATION_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectField>
        {publishError && <Notice tone="error">{publishError}</Notice>}
        <Button type="submit" disabled={publish.isPending} className="w-full">
          {publish.isPending ? 'Publishing…' : 'Publish & start'}
        </Button>
      </form>
    </div>
  );
}
