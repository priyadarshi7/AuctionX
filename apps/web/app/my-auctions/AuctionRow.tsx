'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { ApiError } from '@/lib/apiClient';
import {
  cancelAuctionRequest,
  pauseAuctionRequest,
  publishAuctionRequest,
  startAuctionRequest,
} from '@/lib/auctions';
import { computeEndTime, DURATION_LABELS } from '@/lib/duration';
import { formatCategory, formatCents } from '@/lib/format';
import type { Auction } from '@/lib/types/auction';

type Props = {
  auction: Auction;
  accessToken: string;
  onChanged: () => void;
};

// One row owns its own mutation state (pending/error) rather than the
// parent page tracking a map keyed by auction id — simpler, and each
// action only ever affects the one auction it's attached to anyway.
export function AuctionRow({ auction, accessToken, onChanged }: Props) {
  const [durationHours, setDurationHours] = useState('24');

  // publish+start chained here mirrors auctions/new/page.tsx's own create
  // flow (ADR-0016) — this is exactly the recovery path that ADR documented
  // as missing: a DRAFT sitting here either never got published at all, or
  // (more likely) is a fresh auction that hasn't been touched yet.
  const publishAndStart = useMutation({
    mutationFn: async () => {
      const endTime = computeEndTime(durationHours);
      await publishAuctionRequest(accessToken, auction.id, endTime);
      await startAuctionRequest(accessToken, auction.id);
    },
    onSuccess: onChanged,
  });

  // A PUBLISHED auction already has startTime/endTime stored from a prior
  // publish call (ADR-0009) — start needs no new input, unlike the DRAFT
  // case above.
  const start = useMutation({
    mutationFn: () => startAuctionRequest(accessToken, auction.id),
    onSuccess: onChanged,
  });

  const pause = useMutation({
    mutationFn: () => pauseAuctionRequest(accessToken, auction.id),
    onSuccess: onChanged,
  });

  const cancel = useMutation({
    mutationFn: () => cancelAuctionRequest(accessToken, auction.id),
    onSuccess: onChanged,
  });

  const pending = publishAndStart.isPending || start.isPending || pause.isPending || cancel.isPending;
  const error = publishAndStart.error ?? start.error ?? pause.error ?? cancel.error;
  const errorMessage = error instanceof ApiError ? error.message : error ? 'Something went wrong.' : null;

  return (
    <li className="rounded border border-gray-200 px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <Link href={`/auctions/${auction.id}`} className="min-w-0 flex-1 hover:underline">
          <p className="truncate font-medium">{auction.title}</p>
          <p className="text-sm text-gray-500">
            {formatCategory(auction.category)} · {auction.status}
          </p>
        </Link>
        <p className="whitespace-nowrap font-semibold">{formatCents(auction.currentPriceCents)}</p>
      </div>

      <div className="mt-2 flex items-center gap-2">
        {auction.status === 'DRAFT' && (
          <>
            <select
              value={durationHours}
              onChange={(event) => setDurationHours(event.target.value)}
              className="rounded border border-gray-300 px-2 py-1 text-sm"
            >
              {Object.entries(DURATION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => publishAndStart.mutate()}
              disabled={pending}
              className="rounded bg-black px-3 py-1 text-sm text-white disabled:opacity-50"
            >
              {publishAndStart.isPending ? 'Publishing…' : 'Publish & start'}
            </button>
          </>
        )}

        {auction.status === 'PUBLISHED' && (
          <button
            type="button"
            onClick={() => start.mutate()}
            disabled={pending}
            className="rounded bg-black px-3 py-1 text-sm text-white disabled:opacity-50"
          >
            {start.isPending ? 'Starting…' : 'Start'}
          </button>
        )}

        {auction.status === 'ACTIVE' && (
          <>
            <button
              type="button"
              onClick={() => pause.mutate()}
              disabled={pending}
              className="rounded border border-gray-300 px-3 py-1 text-sm disabled:opacity-50"
            >
              {pause.isPending ? 'Pausing…' : 'Pause'}
            </button>
            <button
              type="button"
              onClick={() => cancel.mutate()}
              disabled={pending}
              className="rounded border border-red-300 px-3 py-1 text-sm text-red-700 disabled:opacity-50"
            >
              {cancel.isPending ? 'Cancelling…' : 'Cancel'}
            </button>
          </>
        )}

        {auction.status === 'PAUSED' && (
          <>
            <button
              type="button"
              onClick={() => start.mutate()}
              disabled={pending}
              className="rounded bg-black px-3 py-1 text-sm text-white disabled:opacity-50"
            >
              {start.isPending ? 'Resuming…' : 'Resume'}
            </button>
            <button
              type="button"
              onClick={() => cancel.mutate()}
              disabled={pending}
              className="rounded border border-red-300 px-3 py-1 text-sm text-red-700 disabled:opacity-50"
            >
              {cancel.isPending ? 'Cancelling…' : 'Cancel'}
            </button>
          </>
        )}
      </div>

      {errorMessage && <p className="mt-2 text-sm text-red-600">{errorMessage}</p>}
    </li>
  );
}
