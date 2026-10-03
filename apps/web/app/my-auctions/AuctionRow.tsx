'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { ApiError } from '@/lib/apiClient';
import { cancelAuctionRequest, pauseAuctionRequest, startAuctionRequest, withdrawAuctionRequest } from '@/lib/auctions';
import { CATEGORY_DISPLAY } from '@/lib/categoryDisplay';
import { formatCents } from '@/lib/format';
import type { Auction } from '@/lib/types/auction';
import { Mascot } from '../components/Mascot';
import { Button, ButtonLink } from '../components/ui/Button';
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
  const [confirmCancel, setConfirmCancel] = useState(false);
  const display = CATEGORY_DISPLAY[auction.category];

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

  const withdraw = useMutation({
    mutationFn: () => withdrawAuctionRequest(accessToken, auction.id),
    onSuccess: onChanged,
  });

  const pending = start.isPending || pause.isPending || cancel.isPending || withdraw.isPending;
  const error = start.error ?? pause.error ?? cancel.error ?? withdraw.error;
  const errorMessage = error instanceof ApiError ? error.message : error ? 'Something went wrong.' : null;

  // Cancelling is destructive, so it needs a second, explicit click. A
  // DRAFT auction is never actually "running" — it hits the exact same
  // cancel endpoint (DRAFT is in CANCELLABLE_STATUSES specifically so a
  // never-published listing can be gotten rid of, ADR-0007: auctions are
  // never hard-deleted), but "Delete" reads more honestly than "Cancel"
  // for something that was never live.
  const isDraft = auction.status === 'DRAFT';
  const cancelControl = confirmCancel ? (
    <span className="flex items-center gap-2">
      <span className="text-sm font-semibold">
        {isDraft ? 'Delete this draft?' : 'Cancel this auction?'}
      </span>
      <Button variant="danger" size="sm" onClick={() => cancel.mutate()} disabled={pending}>
        {cancel.isPending ? (isDraft ? 'Deleting…' : 'Cancelling…') : isDraft ? 'Yes, delete' : 'Yes, cancel'}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setConfirmCancel(false)} disabled={pending}>
        Keep it
      </Button>
    </span>
  ) : (
    <Button variant="danger" size="sm" onClick={() => setConfirmCancel(true)} disabled={pending}>
      {isDraft ? 'Delete' : 'Cancel'}
    </Button>
  );

  return (
    <li className="rounded-2xl border-2 border-line bg-white p-4 shadow-hard-sm">
      <div className="flex items-center gap-4">
        <Link
          href={`/auctions/${auction.id}`}
          className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border-2 border-line bg-cream-2"
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
          {/* DRAFT's currentPriceCents is a placeholder until the seller
              sets a real one on the auction's own page — see below. */}
          <p className="whitespace-nowrap font-display text-lg font-extrabold">
            {auction.status === 'DRAFT' || auction.status === 'PENDING_REVIEW'
              ? 'Not set yet'
              : formatCents(auction.currentPriceCents)}
          </p>
        </div>
      </div>

      {(auction.status === 'DRAFT' ||
        auction.status === 'PENDING_REVIEW' ||
        auction.status === 'PUBLISHED' ||
        auction.status === 'ACTIVE' ||
        auction.status === 'PAUSED') && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t-2 border-line/10 pt-4">
          {/* Routes to the auction's own page rather than publishing
              inline — the AI valuation (ADR-0032) and real price entry
              (SetPriceAndPublishPanel) both live there now, since the
              create form no longer collects a price up front. Publishing
              from here directly would either need to duplicate that price
              form or risk publishing at the placeholder price the auction
              was created with. */}
          {auction.status === 'DRAFT' && (
            <>
              <ButtonLink href={`/auctions/${auction.id}`} size="sm">
                Set price &amp; submit
              </ButtonLink>
              {cancelControl}
            </>
          )}

          {auction.status === 'PENDING_REVIEW' && (
            <>
              <ButtonLink href={`/auctions/${auction.id}`} variant="secondary" size="sm">
                View submission
              </ButtonLink>
              <Button variant="secondary" size="sm" onClick={() => withdraw.mutate()} disabled={pending}>
                {withdraw.isPending ? 'Withdrawing…' : 'Withdraw'}
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
              {auction.heldByAdmin ? (
                <span className="text-sm font-semibold">Paused by a moderator</span>
              ) : (
                <Button size="sm" onClick={() => start.mutate()} disabled={pending}>
                  {start.isPending ? 'Resuming…' : 'Resume'}
                </Button>
              )}
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
