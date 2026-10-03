'use client';

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { listAuctionsRequest, moderateAuctionRequest } from '@/lib/admin';
import { ApiError } from '@/lib/apiClient';
import { CATEGORY_DISPLAY } from '@/lib/categoryDisplay';
import { DOCUMENT_REQUIRED_CATEGORIES } from '@/lib/documents';
import { DURATION_LABELS } from '@/lib/duration';
import { formatCents } from '@/lib/format';
import type { AdminAuction, ModerationAction } from '@/lib/types/admin';
import type { AuctionStatus } from '@/lib/types/auction';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { useAuthStore } from '@/store/authStore';
import { Button } from '../../components/ui/Button';
import { inputClass } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';
import { PageHeader, PageMessage, Skeleton } from '../../components/ui/Page';
import { AuctionStatusPill } from '../../components/ui/StatusPill';
import { DocumentsPanel } from '../../auctions/[id]/DocumentsPanel';
import { ReasonForm } from '../ReasonForm';

const STATUSES: AuctionStatus[] = ['PENDING_REVIEW', 'PUBLISHED', 'ACTIVE', 'PAUSED', 'ENDED', 'CANCELLED'];

// Mirrors the server's allowed source states (admin/repository.ts's
// MODERATION_RULES). Only used to decide which buttons to show; the server
// re-checks atomically, so a stale list can at worst show a button whose
// action then fails with a clear message.
const CAN_PAUSE: AuctionStatus[] = ['ACTIVE'];
const CAN_RESUME: AuctionStatus[] = ['PAUSED'];
const CAN_CANCEL: AuctionStatus[] = ['PUBLISHED', 'ACTIVE', 'PAUSED'];

const VERB: Record<ModerationAction, { prompt: string; confirm: string }> = {
  pause: { prompt: 'Why are you pausing this auction? The seller will be told.', confirm: 'Pause auction' },
  resume: { prompt: 'Resume this auction', confirm: 'Resume auction' },
  cancel: { prompt: 'Why are you cancelling this auction? The seller will be told.', confirm: 'Cancel auction' },
  approve: { prompt: 'Approve this listing', confirm: 'Approve' },
  reject: {
    prompt: 'What does the seller need to fix? They will see this and can resubmit.',
    confirm: 'Send back to seller',
  },
};

function ReviewPanel({ auction, accessToken }: { auction: AdminAuction; accessToken: string }) {
  const display = CATEGORY_DISPLAY[auction.category];
  const needsDocs = DOCUMENT_REQUIRED_CATEGORIES.includes(auction.category);
  const duration = auction.requestedDurationSeconds
    ? (DURATION_LABELS[String(auction.requestedDurationSeconds)] ?? `${auction.requestedDurationSeconds} seconds`)
    : 'not set';

  return (
    <div className="mt-3 rounded-xl border-2 border-line bg-cream-2 p-4 text-sm">
      <div className="grid gap-4 md:grid-cols-[1fr_1fr]">
        <div>
          <p className="font-display text-base font-bold">{auction.title}</p>
          <p className="mt-0.5 text-ink/70">
            {display.emoji} {display.label} · condition {auction.condition.toLowerCase().replace('_', ' ')}
          </p>
          <p className="mt-2 whitespace-pre-wrap text-ink/90">{auction.description}</p>
          <dl className="mt-3 grid grid-cols-2 gap-2">
            <div className="rounded-lg border-2 border-line bg-white p-2">
              <dt className="text-xs text-ink/60">Starting price</dt>
              <dd className="font-semibold">{formatCents(auction.startingPriceCents)}</dd>
            </div>
            <div className="rounded-lg border-2 border-line bg-white p-2">
              <dt className="text-xs text-ink/60">Reserve</dt>
              <dd className="font-semibold">
                {auction.reservePriceCents ? formatCents(auction.reservePriceCents) : 'None'}
              </dd>
            </div>
            <div className="col-span-2 rounded-lg border-2 border-line bg-white p-2">
              <dt className="text-xs text-ink/60">Will run for (starting at approval)</dt>
              <dd className="font-semibold">{duration}</dd>
            </div>
          </dl>
          <p className="mt-2 text-ink/70">
            Seller: {auction.sellerName} ({auction.sellerEmail})
            {auction.submittedAt && ` · submitted ${new Date(auction.submittedAt).toLocaleString()}`}
          </p>
        </div>
        <div>
          {auction.images.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {auction.images.map((src) => (
                <a key={src} href={src} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt="" className="h-24 w-24 rounded-lg border-2 border-line object-cover" />
                </a>
              ))}
            </div>
          ) : (
            <p className="text-ink/70">No photos.</p>
          )}
          <h3 className="mb-1.5 mt-4 font-semibold">
            Documents{needsDocs ? ' (required for this category)' : ''}
          </h3>
          <DocumentsPanel auctionId={auction.id} accessToken={accessToken} editable={false} />
          <div className="mt-4">
            <Notice tone="info">
              Review the listing and paperwork. You are checking that the listing is plausible and consistent, not
              certifying that the item is genuine.
            </Notice>
          </div>
        </div>
      </div>
    </div>
  );
}

function AuctionRow({ auction, accessToken }: { auction: AdminAuction; accessToken: string }) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<ModerationAction | null>(null);
  const [reviewing, setReviewing] = useState(auction.status === 'PENDING_REVIEW');

  const moderate = useMutation({
    mutationFn: ({ action, reason }: { action: ModerationAction; reason?: string }) =>
      moderateAuctionRequest(accessToken, auction.id, action, reason),
    onSuccess: () => {
      setPending(null);
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });
  const error = moderate.error instanceof ApiError ? moderate.error.message : moderate.error ? 'Something went wrong.' : null;
  const isPending = auction.status === 'PENDING_REVIEW';

  return (
    <li className="border-b border-line/10 px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/auctions/${auction.id}`} className="truncate font-display font-bold underline-offset-4 hover:underline">
            {auction.title}
          </Link>
          <p className="truncate text-sm text-ink/70">
            by {auction.sellerEmail} · {formatCents(auction.currentPriceCents)} · {auction.bidCount}{' '}
            {auction.bidCount === 1 ? 'bid' : 'bids'}
            {auction.endTime && ` · ends ${new Date(auction.endTime).toLocaleString()}`}
            {isPending && auction.submittedAt && ` · submitted ${new Date(auction.submittedAt).toLocaleString()}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AuctionStatusPill status={auction.status} />
          {isPending && (
            <>
              <Button size="sm" variant="secondary" onClick={() => setReviewing((v) => !v)}>
                {reviewing ? 'Hide details' : 'Review'}
              </Button>
              <Button size="sm" disabled={moderate.isPending} onClick={() => moderate.mutate({ action: 'approve' })}>
                {moderate.isPending && pending === null ? 'Working…' : 'Approve'}
              </Button>
              <Button size="sm" variant="danger" onClick={() => setPending('reject')}>
                Reject
              </Button>
            </>
          )}
          {CAN_PAUSE.includes(auction.status) && (
            <Button size="sm" variant="secondary" onClick={() => setPending('pause')}>
              Pause
            </Button>
          )}
          {CAN_RESUME.includes(auction.status) && (
            <Button
              size="sm"
              variant="secondary"
              disabled={moderate.isPending}
              onClick={() => moderate.mutate({ action: 'resume' })}
            >
              Resume
            </Button>
          )}
          {CAN_CANCEL.includes(auction.status) && (
            <Button size="sm" variant="danger" onClick={() => setPending('cancel')}>
              Cancel
            </Button>
          )}
        </div>
      </div>

      {isPending && reviewing && <ReviewPanel auction={auction} accessToken={accessToken} />}

      {pending && pending !== 'resume' && pending !== 'approve' && (
        <ReasonForm
          prompt={VERB[pending].prompt}
          confirmLabel={VERB[pending].confirm}
          pending={moderate.isPending}
          error={error}
          onConfirm={(reason) => moderate.mutate({ action: pending, reason })}
          onCancel={() => {
            setPending(null);
            moderate.reset();
          }}
        />
      )}
      {!pending && error && <p className="mt-2 text-sm font-medium">{error}</p>}
    </li>
  );
}

function AuctionsList() {
  const accessToken = useAuthStore((s) => s.accessToken)!;
  const initialStatus = useSearchParams().get('status');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<AuctionStatus | ''>(
    STATUSES.includes(initialStatus as AuctionStatus) ? (initialStatus as AuctionStatus) : '',
  );
  const debouncedSearch = useDebouncedValue(search.trim());

  const filters = {
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
    ...(status ? { status } : {}),
  };
  const query = useInfiniteQuery({
    queryKey: ['admin', 'auctions', filters],
    queryFn: ({ pageParam }) => listAuctionsRequest(accessToken, filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const auctions = query.data?.pages.flatMap((p) => p.auctions) ?? [];

  return (
    <>
      <PageHeader
        title="Auctions"
        subtitle="Review new listings, and pause, resume or cancel any auction with a reason."
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-[1fr_auto]">
        <input
          type="search"
          aria-label="Search auctions by title"
          placeholder="Search by title…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={inputClass(false)}
        />
        <select
          aria-label="Filter by status"
          value={status}
          onChange={(e) => setStatus(e.target.value as AuctionStatus | '')}
          className={inputClass(false)}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === 'PENDING_REVIEW' ? 'Awaiting review' : s}
            </option>
          ))}
        </select>
      </div>

      {query.isLoading && (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      )}
      {query.isError && <PageMessage title="Couldn’t load auctions" body="Try refreshing the page." />}
      {!query.isLoading && !query.isError && auctions.length === 0 && (
        <PageMessage
          title={status === 'PENDING_REVIEW' ? 'Nothing waiting for review' : 'No auctions match'}
          body={status === 'PENDING_REVIEW' ? 'New submissions will show up here.' : 'Try a different search or filter.'}
        />
      )}
      {auctions.length > 0 && (
        <ul className="overflow-hidden rounded-2xl border-2 border-line bg-white">
          {auctions.map((auction) => (
            <AuctionRow key={auction.id} auction={auction} accessToken={accessToken} />
          ))}
        </ul>
      )}
      {query.hasNextPage && (
        <div className="mt-5 flex justify-center">
          <Button variant="secondary" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
            {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </>
  );
}

// useSearchParams needs a Suspense boundary for static rendering.
export default function AdminAuctionsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64" />}>
      <AuctionsList />
    </Suspense>
  );
}
