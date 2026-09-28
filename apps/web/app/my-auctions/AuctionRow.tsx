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
import { CATEGORY_DISPLAY } from '@/lib/categoryDisplay';
import { computeEndTime, DURATION_LABELS } from '@/lib/duration';
import { formatCents } from '@/lib/format';
import type { Auction } from '@/lib/types/auction';
import { Mascot } from '../components/Mascot';
import { Button } from '../components/ui/Button';
import { inputClass } from '../components/ui/Field';
import { Notice } from '../components/ui/Notice';
import { AuctionStatusPill } from '../components/ui/StatusPill';

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
  const [confirmCancel, setConfirmCancel] = useState(false);
  const display = CATEGORY_DISPLAY[auction.category];

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
    onSuccess: () => {
      setConfirmCancel(false);
      onChanged();
    },
  });

  const pending = publishAndStart.isPending || start.isPending || pause.isPending || cancel.isPending;
  const error = publishAndStart.error ?? start.error ?? pause.error ?? cancel.error;
  const errorMessage = error instanceof ApiError ? error.message : error ? 'Something went wrong.' : null;

  // Cancelling is destructive, so it needs a second, explicit click.
  const cancelControl = confirmCancel ? (
    <span className="flex items-center gap-2">
      <span className="text-sm font-semibold">Cancel this auction?</span>
      <Button variant="danger" size="sm" onClick={() => cancel.mutate()} disabled={pending}>
        {cancel.isPending ? 'Cancelling…' : 'Yes, cancel'}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setConfirmCancel(false)} disabled={pending}>
        Keep it
      </Button>
    </span>
  ) : (
    <Button variant="danger" size="sm" onClick={() => setConfirmCancel(true)} disabled={pending}>
      Cancel
    </Button>
  );

  return (
    <li className="rounded-2xl border-2 border-ink bg-white p-4 shadow-hard-sm">
      <div className="flex items-center gap-4">
        <Link
          href={`/auctions/${auction.id}`}
          className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border-2 border-ink bg-cream-2"
          aria-hidden
          tabIndex={-1}
        >
          {auction.images[0] ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={auction.images[0]} alt="" className="h-full w-full object-cover" />
          ) : (
            <Mascot className="h-10 w-10 opacity-70" />
          )}
        </Link>

        <div className="min-w-0 flex-1">
          <Link href={`/auctions/${auction.id}`} className="block truncate font-display text-lg font-bold hover:underline">
            {auction.title}
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink/70">
            <AuctionStatusPill status={auction.status} />
            <span>
              {display.emoji} {display.label}
            </span>
          </div>
        </div>

        <div className="text-right">
          <p className="text-[11px] uppercase tracking-wide text-ink/60">
            {auction.status === 'ACTIVE' ? 'Current bid' : 'Price'}
          </p>
          <p className="whitespace-nowrap font-display text-lg font-extrabold">{formatCents(auction.currentPriceCents)}</p>
        </div>
      </div>

      {(auction.status === 'DRAFT' ||
        auction.status === 'PUBLISHED' ||
        auction.status === 'ACTIVE' ||
        auction.status === 'PAUSED') && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t-2 border-ink/10 pt-4">
          {auction.status === 'DRAFT' && (
            <>
              <label className="sr-only" htmlFor={`duration-${auction.id}`}>
                Duration
              </label>
              <select
                id={`duration-${auction.id}`}
                value={durationHours}
                onChange={(event) => setDurationHours(event.target.value)}
                className={`${inputClass(false)} w-auto py-1.5 text-sm`}
              >
                {Object.entries(DURATION_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <Button size="sm" onClick={() => publishAndStart.mutate()} disabled={pending}>
                {publishAndStart.isPending ? 'Publishing…' : 'Publish & start'}
              </Button>
            </>
          )}

          {auction.status === 'PUBLISHED' && (
            <Button size="sm" onClick={() => start.mutate()} disabled={pending}>
              {start.isPending ? 'Starting…' : 'Start'}
            </Button>
          )}

          {auction.status === 'ACTIVE' && (
            <>
              <Button variant="secondary" size="sm" onClick={() => pause.mutate()} disabled={pending}>
                {pause.isPending ? 'Pausing…' : 'Pause'}
              </Button>
              {cancelControl}
            </>
          )}

          {auction.status === 'PAUSED' && (
            <>
              <Button size="sm" onClick={() => start.mutate()} disabled={pending}>
                {start.isPending ? 'Resuming…' : 'Resume'}
              </Button>
              {cancelControl}
            </>
          )}
        </div>
      )}

      {errorMessage && (
        <div className="mt-3">
          <Notice tone="error">{errorMessage}</Notice>
        </div>
      )}
    </li>
  );
}
