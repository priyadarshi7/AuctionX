'use client';

import { IconSearchOff, IconShieldCheck } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { getAuctionRequest, listBidsRequest } from '@/lib/auctions';
import { isOptimisticBid } from '@/lib/bids';
import { CATEGORY_DISPLAY } from '@/lib/categoryDisplay';
import { formatCents } from '@/lib/format';
import { CONDITION_LABEL, lotRef } from '@/lib/lot';
import { useAuctionSocket } from '@/lib/useAuctionSocket';
import { useAuthStore } from '@/store/authStore';
import { SaleClock } from '../../components/Countdown';
import { PriceTicker } from '../../components/PriceTicker';
import { ButtonLink } from '../../components/ui/Button';
import { Notice } from '../../components/ui/Notice';
import { PageMessage, Skeleton } from '../../components/ui/Page';
import { AuctionStatusPill } from '../../components/ui/StatusPill';
import { BidForm } from './BidForm';
import { BidLedger } from './BidLedger';
import { Gallery } from './Gallery';
import { PendingReviewPanel } from './PendingReviewPanel';
import { SetPriceAndPublishPanel } from './SetPriceAndPublishPanel';
import { ValuationPanel } from './ValuationPanel';

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
          icon={IconSearchOff}
          title="We couldn't find that lot"
          body="It may have been removed, or the link is wrong."
          action={<ButtonLink href="/auctions">Open the catalogue</ButtonLink>}
        />
      </main>
    );
  }

  const { auction } = auctionQuery.data;
  const bids = bidsQuery.data?.bids ?? [];
  const display = CATEGORY_DISPLAY[auction.category];
  const isActive = auction.status === 'ACTIVE';
  // Not live and not public yet: the price/bidding card has nothing true to
  // show, so it is replaced by the seller's own panels (ADR-0041).
  const preLive = auction.status === 'DRAFT' || auction.status === 'PENDING_REVIEW';
  const isSeller = !!user && user.id === auction.sellerId;

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
      <nav aria-label="Breadcrumb" className="eyebrow mb-6 flex items-center gap-2 border-b-2 border-foreground pb-3">
        <Link href="/auctions" className="transition-colors hover:text-foreground">
          Catalogue
        </Link>
        <span aria-hidden>/</span>
        <Link href={`/auctions?category=${auction.category}`} className="transition-colors hover:text-foreground">
          {display.label}
        </Link>
        <span className="ml-auto text-foreground">Lot {lotRef(auction.id)}</span>
      </nav>

      <div className="grid items-start gap-10 lg:grid-cols-[1.1fr_1fr] lg:grid-rows-[auto_1fr] lg:gap-x-14">
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <Gallery images={auction.images} title={auction.title} />
        </div>

        <div className="flex min-w-0 flex-col gap-8 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <div>
            <div className="mb-4">
              <AuctionStatusPill status={auction.status} />
            </div>
            <h1 className="text-4xl font-medium leading-[1.06] tracking-tight sm:text-5xl">{auction.title}</h1>
          </div>

          {/* DRAFT has no real price/schedule yet (startingPriceCents is a
              placeholder until SetPriceAndPublishPanel sets one) — this
              whole card is replaced by the valuation + set-price panels
              below for a DRAFT seller instead of showing meaningless
              numbers. */}
          {!preLive && (
            <div className="panel border-t-[3px] border-t-foreground p-5 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-6">
                <div>
                  <p className="eyebrow mb-2">{isActive ? 'Current bid' : 'Closing price'}</p>
                  <PriceTicker key={auction.id} cents={auction.currentPriceCents} className="text-5xl leading-none" />
                </div>
                <div>
                  <p className="eyebrow mb-2">{isActive ? 'Closes in' : 'Scheduled end'}</p>
                  {isActive ? (
                    <SaleClock endTime={auction.endTime} />
                  ) : (
                    <p className="figures text-lg">
                      {auction.endTime ? new Date(auction.endTime).toLocaleString() : '—'}
                    </p>
                  )}
                </div>
              </div>

              {isActive && (
                <div className="mt-5 flex flex-col gap-4 border-t border-border pt-5">
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
                      <p className="text-sm text-muted-foreground">Log in to place a bid on this item.</p>
                      <ButtonLink href="/login">Log in to bid</ButtonLink>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    A valid bid in the last 30 seconds extends the auction by 30 seconds.
                  </p>
                </div>
              )}

              {/* Honest about what review means (ADR-0041): the listing and
                  its documents were looked at; the item itself was not
                  inspected, so no authenticity promise is made. */}
              {auction.reviewedAt && (
                <p className="mt-5 flex gap-2.5 border-t border-border pt-4 text-xs leading-5 text-muted-foreground">
                  <IconShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-live" stroke={1.7} />
                  Reviewed by AuctionX before going live: listing details and any supporting documents were checked.
                  This is not a guarantee of authenticity.
                </p>
              )}

              {/* Deliberately no direct link to THIS auction's specific order —
                  the auction row has no orderId (ADR-0023 never added one; Order
                  is looked up the other way, by auctionId, only when needed).
                  "Orders" (NavBar) lists every order a participant has. */}
              {auction.status === 'ENDED' && user && (isSeller || iHaveBid) && (
                <div className="mt-5 border-t border-border pt-5">
                  <Notice tone="info">
                    This auction has ended. Check{' '}
                    <Link href="/orders" className="font-medium underline underline-offset-4">
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
              <SetPriceAndPublishPanel
                auctionId={auctionId}
                accessToken={accessToken}
                category={auction.category}
                reviewNote={auction.reviewNote}
              />
            </>
          )}
          {isSeller && accessToken && auction.status === 'PENDING_REVIEW' && (
            <PendingReviewPanel auction={auction} accessToken={accessToken} />
          )}
          {!isSeller && user?.role === 'ADMIN' && auction.status === 'PENDING_REVIEW' && (
            <Notice tone="info">
              This listing is waiting for review.{' '}
              <Link href="/admin/auctions?status=PENDING_REVIEW" className="font-medium underline underline-offset-4">
                Open the review queue
              </Link>
            </Notice>
          )}

          {/* A lot that has not gone live can have no bids to list. */}
          {!preLive && (
            <BidLedger
              bids={bids}
              startingPriceCents={auction.startingPriceCents}
              userId={user?.id}
              leadingBidId={leadingBid?.id}
            />
          )}
        </div>

        <section aria-labelledby="about-heading" className="min-w-0 lg:col-start-1 lg:row-start-2">
          <h2 id="about-heading" className="border-b border-border-strong pb-2 text-2xl font-medium">
            Catalogue note
          </h2>
          {/* The opening capital only works with enough text to wrap around it. */}
          <p
            className={`mt-4 flow-root whitespace-pre-wrap break-words font-serif text-lg leading-8 ${
              auction.description.length > 140 ? 'drop-cap' : ''
            }`}
          >
            {auction.description}
          </p>
          {/* Term, dot leader, value: the way a lot's particulars are set. */}
          <dl className="mt-6 text-sm">
            {[
              { term: 'Department', value: display.label },
              { term: 'Condition', value: CONDITION_LABEL[auction.condition] ?? auction.condition },
              {
                // DRAFT's startingPriceCents is a meaningless placeholder
                // until SetPriceAndPublishPanel sets a real one.
                term: 'Starting price',
                value: auction.status === 'DRAFT' ? 'Not set yet' : formatCents(auction.startingPriceCents),
              },
            ].map(({ term, value }) => (
              <div key={term} className="flex items-baseline gap-3 py-2">
                <dt className="eyebrow">{term}</dt>
                <span aria-hidden className="leader" />
                <dd className="figures text-lg">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </main>
  );
}
