'use client';

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { listAuctionsRequest, moderateAuctionRequest } from '@/lib/admin';
import { ApiError } from '@/lib/apiClient';
import { formatCents } from '@/lib/format';
import type { AdminAuction, ModerationAction } from '@/lib/types/admin';
import type { AuctionStatus } from '@/lib/types/auction';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { useAuthStore } from '@/store/authStore';
import { Button } from '../../components/ui/Button';
import { inputClass } from '../../components/ui/Field';
import { PageHeader, PageMessage, Skeleton } from '../../components/ui/Page';
import { AuctionStatusPill } from '../../components/ui/StatusPill';
import { ReasonForm } from '../ReasonForm';

const STATUSES: AuctionStatus[] = ['DRAFT', 'PUBLISHED', 'ACTIVE', 'PAUSED', 'ENDED', 'CANCELLED'];

// Mirrors the server's allowed source states (admin/repository.ts's
// MODERATION_RULES). Only used to decide which buttons to show; the server
// re-checks atomically, so a stale list can at worst show a button whose
// action then fails with a clear message.
const CAN_PAUSE: AuctionStatus[] = ['ACTIVE'];
const CAN_RESUME: AuctionStatus[] = ['PAUSED'];
const CAN_CANCEL: AuctionStatus[] = ['DRAFT', 'PUBLISHED', 'ACTIVE', 'PAUSED'];

const VERB: Record<ModerationAction, { prompt: string; confirm: string }> = {
  pause: { prompt: 'Why are you pausing this auction?', confirm: 'Pause auction' },
  resume: { prompt: 'Resume this auction', confirm: 'Resume auction' },
  cancel: { prompt: 'Why are you cancelling this auction? The seller will be told.', confirm: 'Cancel auction' },
};

function AuctionRow({ auction, accessToken }: { auction: AdminAuction; accessToken: string }) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<ModerationAction | null>(null);

  const moderate = useMutation({
    mutationFn: ({ action, reason }: { action: ModerationAction; reason?: string }) =>
      moderateAuctionRequest(accessToken, auction.id, action, reason),
    onSuccess: () => {
      setPending(null);
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });
  const error = moderate.error instanceof ApiError ? moderate.error.message : moderate.error ? 'Something went wrong.' : null;

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
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AuctionStatusPill status={auction.status} />
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

      {pending && pending !== 'resume' && (
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

export default function AdminAuctionsPage() {
  const accessToken = useAuthStore((s) => s.accessToken)!;
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<AuctionStatus | ''>('');
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
      <PageHeader title="Auctions" subtitle="Every auction in any state. Pause, resume or cancel with a reason." />

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
              {s}
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
        <PageMessage title="No auctions match" body="Try a different search or filter." />
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
