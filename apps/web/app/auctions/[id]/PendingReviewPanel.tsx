'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/apiClient';
import { withdrawAuctionRequest } from '@/lib/auctions';
import { DURATION_LABELS } from '@/lib/duration';
import type { Auction } from '@/lib/types/auction';
import { Button } from '../../components/ui/Button';
import { Notice } from '../../components/ui/Notice';
import { DocumentsPanel } from './DocumentsPanel';

// What the seller sees once they have submitted (ADR-0041). The documents
// are read-only here on purpose: the reviewer approves exactly what was
// submitted. "Withdraw" is the way to change anything.
export function PendingReviewPanel({ auction, accessToken }: { auction: Auction; accessToken: string }) {
  const queryClient = useQueryClient();
  const withdraw = useMutation({
    mutationFn: () => withdrawAuctionRequest(accessToken, auction.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['auctions', 'detail', auction.id] }),
  });
  const error = withdraw.error instanceof ApiError ? withdraw.error.message : withdraw.error ? 'Something went wrong.' : null;
  const duration = auction.requestedDurationSeconds
    ? (DURATION_LABELS[String(auction.requestedDurationSeconds)] ?? `${auction.requestedDurationSeconds} seconds`)
    : null;

  return (
    <div className="rounded-2xl border-2 border-line bg-white p-5 shadow-hard">
      <h2 className="font-display text-lg font-extrabold">Waiting for review</h2>
      <div className="mt-3">
        <Notice tone="info">
          <p>
            Submitted{auction.submittedAt ? ` ${new Date(auction.submittedAt).toLocaleString()}` : ''}. A reviewer
            will check the listing details and documents, and you’ll be notified either way.
          </p>
          {duration && (
            <p className="mt-1 text-ink/70">
              Once approved it goes live right away and runs for {duration.toLowerCase()}. The timer starts at
              approval, not now.
            </p>
          )}
        </Notice>
      </div>

      <h3 className="mb-2 mt-5 text-sm font-semibold">Documents you submitted</h3>
      <DocumentsPanel auctionId={auction.id} accessToken={accessToken} editable={false} />

      {error && (
        <div className="mt-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      <div className="mt-5 border-t-2 border-line/10 pt-4">
        <Button variant="secondary" size="sm" onClick={() => withdraw.mutate()} disabled={withdraw.isPending}>
          {withdraw.isPending ? 'Withdrawing…' : 'Withdraw to make changes'}
        </Button>
        <p className="mt-1.5 text-xs text-ink/60">This returns it to a draft. You’ll need to submit it again.</p>
      </div>
    </div>
  );
}
