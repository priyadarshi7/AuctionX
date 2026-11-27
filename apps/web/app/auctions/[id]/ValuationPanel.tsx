'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { ApiError } from '@/lib/apiClient';
import { formatCategory, formatCents } from '@/lib/format';
import { regenerateAuctionValuationRequest } from '@/lib/valuation';
import { PriceTicker } from '../../components/PriceTicker';
import { Button } from '../../components/ui/Button';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Page';
import { ValuationStatusPill } from '../../components/ui/StatusPill';
import { PriceRuler } from './PriceRuler';
import { useValuation, valuationKey } from './useValuation';

// The model's own number about itself, so it is shown as a rough band and
// labelled as such, never as a probability of being right.
function Confidence({ value }: { value: number }) {
  const bars = Math.max(1, Math.round(value * 5));
  const word = value < 0.4 ? 'Low' : value < 0.7 ? 'Moderate' : 'High';
  return (
    <div className="flex items-center gap-3">
      <span aria-hidden className="flex gap-1">
        {[1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={`h-3.5 w-1.5 ${i <= bars ? 'bg-accent' : 'bg-muted'}`} />
        ))}
      </span>
      <p className="text-sm">
        {word} confidence <span className="text-muted-foreground">(the model&apos;s own rating)</span>
      </p>
    </div>
  );
}

// Seller-only (ADR-0032 — a private pricing signal, never shown to
// bidders), so this is only ever mounted from page.tsx behind its own
// `isSeller` check — no ownership gating needed here, the backend already
// enforces it and a non-owner's request would 403/404 anyway.
export function ValuationPanel({ auctionId, accessToken }: { auctionId: string; accessToken: string }) {
  const queryClient = useQueryClient();
  const valuationQuery = useValuation(auctionId, accessToken);

  const regenerate = useMutation({
    mutationFn: () => regenerateAuctionValuationRequest(accessToken, auctionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: valuationKey(auctionId) });
    },
  });

  if (valuationQuery.isLoading) return <Skeleton className="h-48 w-full" />;

  if (valuationQuery.isError || !valuationQuery.data) {
    // A network/auth problem fetching the valuation itself — distinct from
    // the valuation's own FAILED status, which renders below instead.
    return null;
  }

  const { valuation, comparables } = valuationQuery.data;
  const regenerating = regenerate.isPending;
  const regenerateError = regenerate.error instanceof ApiError ? regenerate.error.message : null;

  return (
    <section aria-labelledby="appraisal-heading" className="panel border-t-[3px] border-t-accent p-5 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-3 border-b border-border pb-3">
        <h2 id="appraisal-heading" className="text-2xl font-medium">
          AI appraisal
        </h2>
        <ValuationStatusPill status={valuation.status} />
      </div>

      {valuation.status === 'PENDING' && (
        <div role="status" className="flex flex-col gap-4">
          <p className="font-serif text-lg italic">Reading your photos and description…</p>
          <Skeleton className="h-12 w-44" />
          <Skeleton className="h-4 w-full" />
          <p className="text-xs text-muted-foreground">You can set your price below without waiting.</p>
        </div>
      )}

      {valuation.status === 'FAILED' && (
        <div className="flex flex-col gap-3">
          <Notice tone="error">{valuation.errorMessage ?? 'The AI valuation attempt failed.'}</Notice>
          <p className="text-sm text-muted-foreground">This doesn&apos;t stop you pricing and submitting your item.</p>
          <Button variant="secondary" size="sm" onClick={() => regenerate.mutate()} disabled={regenerating}>
            {regenerating ? 'Retrying…' : 'Try again'}
          </Button>
          {regenerateError && <Notice tone="error">{regenerateError}</Notice>}
        </div>
      )}

      {valuation.status === 'COMPLETE' && (
        <div className="word-in flex flex-col gap-5">
          <div>
            <p className="eyebrow mb-1">Estimated value</p>
            <PriceTicker cents={valuation.estimatedValueCents ?? 0} className="text-5xl leading-none" />
          </div>
          <PriceRuler
            low={valuation.priceRangeLowCents ?? 0}
            high={valuation.priceRangeHighCents ?? 0}
            estimate={valuation.estimatedValueCents ?? 0}
          />
          {valuation.confidence !== null && <Confidence value={valuation.confidence} />}
          {valuation.explanation && (
            <p className="border-l-2 border-accent pl-4 font-serif text-lg leading-7">{valuation.explanation}</p>
          )}

          {comparables && (
            <div>
              <p className="eyebrow border-b border-border-strong pb-1.5">Sold here, same department</p>
              {comparables.length === 0 ? (
                <p className="py-3 text-sm text-muted-foreground">No past sales in this department yet.</p>
              ) : (
                <ul>
                  {comparables.map((sale) => (
                    <li key={sale.auctionId} className="border-b border-border">
                      <Link
                        href={`/auctions/${sale.auctionId}`}
                        className="group flex items-baseline gap-3 py-2 hover:bg-accent-soft"
                      >
                        <span className="min-w-0 truncate font-serif text-base underline-offset-4 group-hover:underline">
                          {sale.title}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">{formatCategory(sale.condition)}</span>
                        <span aria-hidden className="leader" />
                        <span className="figures shrink-0 text-lg">{formatCents(sale.priceCents)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {regenerateError && <Notice tone="error">{regenerateError}</Notice>}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-xs text-xs text-muted-foreground">
              An AI guess{valuation.model ? ` from ${valuation.model}` : ''} with no live market data. Not an appraisal
              and no check of authenticity.
            </p>
            <Button variant="secondary" size="sm" onClick={() => regenerate.mutate()} disabled={regenerating}>
              {regenerating ? 'Asking…' : 'Ask again'}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
