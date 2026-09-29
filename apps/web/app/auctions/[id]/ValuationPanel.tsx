'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/apiClient';
import { formatCents } from '@/lib/format';
import { getAuctionValuationRequest, regenerateAuctionValuationRequest } from '@/lib/valuation';
import { Button } from '../../components/ui/Button';
import { Notice } from '../../components/ui/Notice';
import { ValuationStatusPill } from '../../components/ui/StatusPill';

// Seller-only (ADR-0032 — a private pricing signal, never shown to
// bidders), so this is only ever mounted from page.tsx behind its own
// `isSeller` check — no ownership gating needed here, the backend already
// enforces it and a non-owner's request would 403/404 anyway.
export function ValuationPanel({ auctionId, accessToken }: { auctionId: string; accessToken: string }) {
  const queryClient = useQueryClient();
  const queryKey = ['auctions', 'valuation', auctionId];

  const valuationQuery = useQuery({
    queryKey,
    queryFn: () => getAuctionValuationRequest(accessToken, auctionId),
    // The consumer (modules/ai/consumer.ts) usually resolves within a few
    // seconds on a local moondream model — same "poll while pending" shape
    // as app/orders/[id]/page.tsx's payment status, stopping the instant it
    // reaches a terminal state (COMPLETE or FAILED).
    refetchInterval: (query) => (query.state.data?.valuation.status === 'PENDING' ? 1500 : false),
  });

  const regenerate = useMutation({
    mutationFn: () => regenerateAuctionValuationRequest(accessToken, auctionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  if (valuationQuery.isLoading) {
    return (
      <div className="rounded-2xl border-2 border-ink bg-cream-2 p-5 shadow-hard-sm">
        <p className="text-sm text-ink/60">Loading AI valuation…</p>
      </div>
    );
  }

  if (valuationQuery.isError || !valuationQuery.data) {
    // A network/auth problem fetching the valuation itself — distinct from
    // the valuation's own FAILED status, which renders below instead.
    return null;
  }

  const { valuation } = valuationQuery.data;
  const regenerating = regenerate.isPending;
  const regenerateError = regenerate.error instanceof ApiError ? regenerate.error.message : null;

  return (
    <div className="rounded-2xl border-2 border-ink bg-cream-2 p-5 shadow-hard-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-display text-lg font-extrabold">AI Valuation</h2>
        <ValuationStatusPill status={valuation.status} />
      </div>

      {valuation.status === 'PENDING' && (
        <Notice tone="info">The AI is analyzing this listing. This usually takes a few seconds.</Notice>
      )}

      {valuation.status === 'FAILED' && (
        <div className="flex flex-col gap-3">
          <Notice tone="error">{valuation.errorMessage ?? 'The AI valuation attempt failed.'}</Notice>
          <Button variant="secondary" size="sm" onClick={() => regenerate.mutate()} disabled={regenerating}>
            {regenerating ? 'Retrying…' : 'Try again'}
          </Button>
        </div>
      )}

      {valuation.status === 'COMPLETE' && (
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Estimated value</p>
            <p className="font-display text-3xl font-extrabold">{formatCents(valuation.estimatedValueCents ?? 0)}</p>
            <p className="text-sm text-ink/70">
              Range: {formatCents(valuation.priceRangeLowCents ?? 0)} – {formatCents(valuation.priceRangeHighCents ?? 0)}
              {valuation.confidence !== null && (
                <> · {Math.round(valuation.confidence * 100)}% confidence</>
              )}
            </p>
          </div>
          {valuation.explanation && <p className="text-sm text-ink/80">{valuation.explanation}</p>}
          {/* Not hedging language for its own sake — a real, disclosed
              accuracy limit of a small self-hosted model (ADR-0032), the
              same caveat this project's own docs state plainly rather than
              hide. */}
          <p className="text-xs text-ink/50">
            Rough AI estimate from a free, self-hosted model — a starting point, not an appraisal.
          </p>
          {regenerateError && <Notice tone="error">{regenerateError}</Notice>}
          <Button variant="secondary" size="sm" onClick={() => regenerate.mutate()} disabled={regenerating}>
            {regenerating ? 'Regenerating…' : 'Regenerate'}
          </Button>
        </div>
      )}
    </div>
  );
}
