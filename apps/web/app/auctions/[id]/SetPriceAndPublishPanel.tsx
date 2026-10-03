'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { ApiError } from '@/lib/apiClient';
import { submitAuctionRequest, updateAuctionRequest } from '@/lib/auctions';
import { DOCUMENT_REQUIRED_CATEGORIES } from '@/lib/documents';
import { DURATION_LABELS } from '@/lib/duration';
import type { AuctionCategory } from '@/lib/types/auction';
import { setPriceAndPublishFormSchema, type SetPriceAndPublishFormValues } from '@/lib/validation/auction';
import { Button } from '../../components/ui/Button';
import { Field, SelectField, inputClass } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';
import { DocumentsPanel } from './DocumentsPanel';

// Seller-only, DRAFT-only — the create form (app/auctions/new/page.tsx)
// deliberately doesn't collect price, so this is where a real price is set
// for the first time, alongside (and informed by) the AI valuation panel
// shown right above this one on the same page.
//
// "Submit" rather than "Publish" (ADR-0041): the SERVER decides whether the
// listing waits for an admin's review or goes straight live, so this form
// never claims either; it reports what actually happened. The duration is
// sent as a duration, not an end time, so the clock starts when the auction
// goes live, which for a reviewed listing is after approval.
export function SetPriceAndPublishPanel({
  auctionId,
  accessToken,
  category,
  reviewNote,
}: {
  auctionId: string;
  accessToken: string;
  category: AuctionCategory;
  reviewNote: string | null;
}) {
  const queryClient = useQueryClient();
  const needsDocuments = DOCUMENT_REQUIRED_CATEGORIES.includes(category);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SetPriceAndPublishFormValues>({
    resolver: zodResolver(setPriceAndPublishFormSchema),
    defaultValues: { durationSeconds: '86400' },
  });

  const submit = useMutation({
    mutationFn: async (values: SetPriceAndPublishFormValues) => {
      const startingPriceCents = Math.round(Number(values.startingPrice) * 100);
      const reservePriceCents =
        values.reservePrice && values.reservePrice !== '' ? Math.round(Number(values.reservePrice) * 100) : undefined;

      await updateAuctionRequest(accessToken, auctionId, {
        startingPriceCents,
        ...(reservePriceCents !== undefined ? { reservePriceCents } : {}),
      });
      return submitAuctionRequest(accessToken, auctionId, Number(values.durationSeconds));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['auctions', 'detail', auctionId] });
    },
  });

  const submitError = submit.error instanceof ApiError ? submit.error.message : submit.error ? 'Something went wrong.' : null;

  return (
    <div className="rounded-2xl border-2 border-line bg-white p-5 shadow-hard">
      <h2 className="font-display text-lg font-extrabold">Price, documents &amp; submit</h2>
      <p className="mt-1 text-sm text-ink/70">
        This draft is only visible to you. Use the AI valuation above as a rough guide and set your own price. When you
        submit, AuctionX may review the listing before it goes live. Your auction’s timer only starts once it is live.
      </p>

      {reviewNote && (
        <div className="mt-4">
          <Notice tone="error">
            <p className="font-semibold">Changes requested by the reviewer</p>
            <p className="mt-0.5">{reviewNote}</p>
            <p className="mt-1 text-ink/70">Fix what they mention, then submit again.</p>
          </Notice>
        </div>
      )}

      <form
        onSubmit={handleSubmit((values) => submit.mutate(values))}
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
        <SelectField
          id="durationSeconds"
          label="How long should it run once live?"
          error={errors.durationSeconds?.message}
          {...register('durationSeconds')}
        >
          {Object.entries(DURATION_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectField>

        <div>
          <p className="mb-1.5 text-sm font-semibold">
            Supporting documents{needsDocuments ? ' (required for this category)' : ' (optional)'}
          </p>
          <p className="mb-2 text-sm text-ink/70">
            A certificate, receipt or provenance helps the reviewer approve your listing. Only you and AuctionX
            reviewers can see them. They are never shown publicly.
          </p>
          <DocumentsPanel auctionId={auctionId} accessToken={accessToken} editable />
        </div>

        {submitError && <Notice tone="error">{submitError}</Notice>}
        <Button type="submit" disabled={submit.isPending} className="w-full">
          {submit.isPending ? 'Submitting…' : 'Submit listing'}
        </Button>
      </form>
    </div>
  );
}
