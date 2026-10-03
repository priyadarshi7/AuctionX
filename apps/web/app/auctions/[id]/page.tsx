'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { getAuctionRequest, listBidsRequest } from '@/lib/auctions';
import { isOptimisticBid } from '@/lib/bids';
import { CATEGORY_DISPLAY } from '@/lib/categoryDisplay';
import { formatCents } from '@/lib/format';
import { useAuctionSocket } from '@/lib/useAuctionSocket';
import { useTimeRemaining } from '@/lib/useTimeRemaining';
import { useAuthStore } from '@/store/authStore';
import { ButtonLink } from '../../components/ui/Button';
import { Notice } from '../../components/ui/Notice';
import { PageMessage, Skeleton } from '../../components/ui/Page';
import { AuctionStatusPill } from '../../components/ui/StatusPill';
import { BidForm } from './BidForm';
import { Gallery } from './Gallery';
import { SetPriceAndPublishPanel } from './SetPriceAndPublishPanel';
import { ValuationPanel } from './ValuationPanel';

const CONDITION_LABEL: Record<string, string> = {
  NEW: 'New',
  LIKE_NEW: 'Like new',
  GOOD: 'Good',
  FAIR: 'Fair',
  POOR: 'Poor',
};

export default function AuctionDetailPage() {
  const params = useParams<{ id: string }>();
  const auctionId = params.id;
  const user = useAuthStore((state) => state.user);
  const accessToken = useAuthStore((state) => state.accessToken);
  const authStatus = useAuthStore((state) => state.status);

  const auctionQuery = useQuery({
    // accessToken is part of the key, not just an argument: SilentRefresh
    // (app/providers.tsx) resolves the token asynchronously on mount, racing
    // with this query. Without the token in the key, a DRAFT auction fetched
    // before the token arrives would 404 once and never automatically
    // retry — the key must change from (id, null) to (id, token) for
    // react-query to treat it as a new query and refetch.
    queryKey: ['auctions', 'detail', auctionId, accessToken],
    queryFn: () => getAuctionRequest(auctionId, accessToken),
  });

  const bidsQuery = useQuery({
    queryKey: ['auctions', 'bids', auctionId],
    queryFn: () => listBidsRequest(auctionId),
    // Only worth asking once the auction itself is known to exist — no
    // point firing a second request for an id that just 404'd.
    enabled: auctionQuery.isSuccess,
  });

  // Live updates arrive as a WebSocket signal (ADR-0020/0021) that
  // invalidates these same two query keys. Only connects while ACTIVE —
  // nothing changes on any other status worth watching live.
  useAuctionSocket(auctionId, auctionQuery.data?.auction.status === 'ACTIVE', accessToken);

  const timeRemaining = useTimeRemaining(auctionQuery.data?.auction.endTime ?? null);

  if (auctionQuery.isLoading) {
    return (
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10" aria-busy="true">
        <div className="grid gap-10 lg:grid-cols-[1.1fr_1fr]">
          <Skeleton className="aspect-square w-full" />
          <div className="flex flex-col gap-4">
            <Skeleton className="h-10 w-3/4" />
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-40 w-full" />
          </div>
        </div>
      </main>
    );
  }

  if (auctionQuery.isError || !auctionQuery.data) {
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-16">
        <PageMessage
          title="We couldn't find that auction"
          body="It may have been removed, or the link is wrong."
          action={<ButtonLink href="/auctions">Browse auctions</ButtonLink>}
        />
      </main>
    );
  }

  const { auction } = auctionQuery.data;
  const bids = bidsQuery.data?.bids ?? [];
  const display = CATEGORY_DISPLAY[auction.category];
  const isActive = auction.status === 'ACTIVE';
  const isSeller = !!user && user.id === auction.sellerId;
  const urgent = isActive && /^\d+s$/.test(timeRemaining);

  // Derived from server data, never client state: the leader is whoever
  // holds the highest accepted bid right now.
  const leadingBid = bids.reduce<(typeof bids)[number] | null>(
    (best, bid) => (best === null || bid.amountCents > best.amountCents ? bid : best),
    null,
  );
  const iHaveBid = !!user && bids.some((bid) => bid.bidderId === user.id);
  // A pending (not yet server-confirmed) bid never counts as "leading" — the
  // claim only becomes true once the server accepts it (ADR-0037).
  const iAmLeading = !!user && leadingBid?.bidderId === user.id && !isOptimisticBid(leadingBid);

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
      <nav aria-label="Breadcrumb" className="mb-6 text-sm text-ink/70">
        <Link href="/auctions" className="font-semibold underline underline-offset-4">
          Browse
        </Link>{' '}
        / {display.label}
      </nav>

      <div className="grid items-start gap-10 lg:grid-cols-[1.1fr_1fr]">
        <div className="flex flex-col gap-8">
          <Gallery images={auction.images} title={auction.title} />

          <section aria-labelledby="about-heading">
            <h2 id="about-heading" className="font-display text-2xl font-extrabold">
              About this item
            </h2>
            <p className="mt-3 whitespace-pre-wrap text-ink/80">{auction.description}</p>
            <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-xl border-2 border-line bg-white p-3">
                <dt className="text-ink/60">Condition</dt>
                <dd className="font-semibold">{CONDITION_LABEL[auction.condition] ?? auction.condition}</dd>
              </div>
              <div className="rounded-xl border-2 border-line bg-white p-3">
                <dt className="text-ink/60">Starting price</dt>
                {/* DRAFT's startingPriceCents is a meaningless placeholder
                    until SetPriceAndPublishPanel sets a real one. */}
                <dd className="font-semibold">
                  {auction.status === 'DRAFT' ? 'Not set yet' : formatCents(auction.startingPriceCents)}
                </dd>
              </div>
            </dl>
          </section>
        </div>

        <div className="flex flex-col gap-6 lg:sticky lg:top-24">
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="rounded-full border-2 border-line bg-cream px-2.5 py-0.5 text-xs font-semibold">
                {display.emoji} {display.label}
              </span>
              <AuctionStatusPill status={auction.status} />
            </div>
            <h1 className="font-display text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl">
              {auction.title}
            </h1>
          </div>

          {/* DRAFT has no real price/schedule yet (startingPriceCents is a
              placeholder until SetPriceAndPublishPanel sets one) — this
              whole card is replaced by the valuation + set-price panels
              below for a DRAFT seller instead of showing meaningless
              numbers. */}
          {auction.status !== 'DRAFT' && (
            <div className="rounded-2xl border-2 border-line bg-white p-5 shadow-hard">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">
                    {isActive ? 'Current bid' : 'Final price'}
                  </p>
                  <p className="font-display text-4xl font-extrabold">{formatCents(auction.currentPriceCents)}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">
                    {isActive ? 'Time left' : 'Scheduled end'}
                  </p>
                  {isActive ? (
                    <p
                      className={`mt-1 inline-flex items-center gap-1.5 rounded-full border-2 border-line px-3 py-1 font-display text-lg font-extrabold tabular-nums ${
                        urgent ? 'bg-pink' : 'bg-green'
                      }`}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-ink" />
                      {timeRemaining}
                    </p>
                  ) : (
                    <p className="mt-1 font-semibold">
                      {auction.endTime ? new Date(auction.endTime).toLocaleString() : '—'}
                    </p>
                  )}
                </div>
              </div>

              {isActive && (
                <div className="mt-5 flex flex-col gap-4 border-t-2 border-line/10 pt-5">
                  {iAmLeading && <Notice tone="success">You&apos;re the highest bidder. Stay ready to defend it.</Notice>}
                  {iHaveBid && !iAmLeading && !(leadingBid && isOptimisticBid(leadingBid)) && (
                    <Notice tone="info">You&apos;ve been outbid. Place a higher bid to get back in front.</Notice>
                  )}

                  {authStatus === 'authenticated' && accessToken && user && !isSeller && (
                    <BidForm
                      auctionId={auctionId}
                      currentPriceCents={auction.currentPriceCents}
                      accessToken={accessToken}
                    />
                  )}
                  {isSeller && <Notice tone="info">This is your auction, so you can&apos;t bid on it.</Notice>}
                  {authStatus === 'anonymous' && (
                    <div className="flex flex-col gap-3">
                      <p className="text-sm text-ink/70">Log in to place a bid on this item.</p>
                      <ButtonLink href="/login">Log in to bid</ButtonLink>
                    </div>
                  )}
                  <p className="text-xs text-ink/60">
                    A valid bid in the last 30 seconds extends the auction by 30 seconds.
                  </p>
                </div>
              )}

              {/* Deliberately no direct link to THIS auction's specific order —
                  the auction row has no orderId (ADR-0023 never added one; Order
                  is looked up the other way, by auctionId, only when needed).
                  "Orders" (NavBar) lists every order a participant has. */}
              {auction.status === 'ENDED' && user && (isSeller || iHaveBid) && (
                <div className="mt-5 border-t-2 border-line/10 pt-5">
                  <Notice tone="info">
                    This auction has ended. Check{' '}
                    <Link href="/orders" className="font-semibold underline underline-offset-4">
                      your orders
                    </Link>{' '}
                    for the outcome.
                  </Notice>
                </div>
              )}
            </div>
          )}

          {/* Seller-only, and only while DRAFT (ADR-0032 + real usage
              feedback): the valuation is meant to inform the price
              decision, so it must never appear once the auction is
              already published/live/ended — showing it after the fact
              would be pointless and was reported as a real UX problem. */}
          {isSeller && accessToken && auction.status === 'DRAFT' && (
            <>
              <ValuationPanel auctionId={auctionId} accessToken={accessToken} />
              <SetPriceAndPublishPanel auctionId={auctionId} accessToken={accessToken} />
            </>
          )}

          <section aria-labelledby="bids-heading">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 id="bids-heading" className="font-display text-xl font-extrabold">
                Bid history
              </h2>
              <span className="text-sm text-ink/60">
                {bids.length} {bids.length === 1 ? 'bid' : 'bids'}
              </span>
            </div>
            {bids.length === 0 ? (
              <p className="rounded-xl border-2 border-dashed border-line/30 p-4 text-sm text-ink/70">
                No bids yet. Be the first.
              </p>
            ) : (
              <ul className="overflow-hidden rounded-2xl border-2 border-line bg-white">
                {bids.map((bid) => {
                  const pending = isOptimisticBid(bid);
                  const isLeader = bid.id === leadingBid?.id && !pending;
                  const mine = !!user && bid.bidderId === user.id;
                  return (
                    <li
                      key={bid.id}
                      className={`flex items-center justify-between gap-3 border-b border-line/10 px-4 py-2.5 text-sm last:border-b-0 ${
                        isLeader ? 'bg-yellow/30' : ''
                      }`}
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-ink/70">{new Date(bid.createdAt).toLocaleString()}</span>
                        {isLeader && (
                          <span className="rounded-full border-2 border-line bg-yellow px-2 py-0 text-[11px] font-bold">
                            Leading
                          </span>
                        )}
                        {mine && (
                          <span className="rounded-full border-2 border-line bg-cyan px-2 py-0 text-[11px] font-bold">
                            You
                          </span>
                        )}
                        {pending && (
                          <span className="animate-pulse rounded-full border-2 border-line bg-white px-2 py-0 text-[11px] font-bold">
                            Placing…
                          </span>
                        )}
                      </span>
                      <span className="font-display font-extrabold">{formatCents(bid.amountCents)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
