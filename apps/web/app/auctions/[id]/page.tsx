'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { getAuctionRequest, listBidsRequest } from '@/lib/auctions';
import { formatCategory, formatCents } from '@/lib/format';
import { useAuctionSocket } from '@/lib/useAuctionSocket';
import { useTimeRemaining } from '@/lib/useTimeRemaining';
import { useAuthStore } from '@/store/authStore';
import { BidForm } from './BidForm';

export default function AuctionDetailPage() {
  const params = useParams<{ id: string }>();
  const auctionId = params.id;
  const user = useAuthStore((state) => state.user);
  const accessToken = useAuthStore((state) => state.accessToken);
  const authStatus = useAuthStore((state) => state.status);

  const auctionQuery = useQuery({
    queryKey: ['auctions', 'detail', auctionId],
    queryFn: () => getAuctionRequest(auctionId),
  });

  const bidsQuery = useQuery({
    queryKey: ['auctions', 'bids', auctionId],
    queryFn: () => listBidsRequest(auctionId),
    // Only worth asking once the auction itself is known to exist — no
    // point firing a second request for an id that just 404'd.
    enabled: auctionQuery.isSuccess,
  });

  // Replaces ADR-0016's 5s poll: live updates now arrive as a WebSocket
  // signal (ADR-0020/0021) that invalidates these same two query keys,
  // rather than an unconditional interval. Only connects while ACTIVE —
  // same condition the old poll used, since nothing changes on a
  // DRAFT/PUBLISHED/PAUSED/ENDED/CANCELLED auction worth watching live.
  useAuctionSocket(auctionId, auctionQuery.data?.auction.status === 'ACTIVE', accessToken);

  const timeRemaining = useTimeRemaining(auctionQuery.data?.auction.endTime ?? null);

  if (auctionQuery.isLoading) {
    return (
      <main className="flex-1 p-6">
        <p className="text-gray-500">Loading…</p>
      </main>
    );
  }

  if (auctionQuery.isError || !auctionQuery.data) {
    return (
      <main className="flex-1 p-6">
        <p className="text-red-600">Auction not found.</p>
      </main>
    );
  }

  const { auction } = auctionQuery.data;
  const bids = bidsQuery.data?.bids ?? [];

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">{auction.title}</h1>
        <p className="text-sm text-gray-500">
          {formatCategory(auction.category)} · {auction.condition} · {auction.status}
        </p>
      </div>

      {auction.images.length > 0 && (
        <div className="flex gap-2 overflow-x-auto">
          {auction.images.map((url) => (
            // Storage domain isn't fixed yet (local s3mock vs. prod R2), so
            // next/image's remotePatterns can't be configured until
            // deployment — see app/auctions/new/page.tsx's comment.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={url}
              src={url}
              alt=""
              className="h-48 w-48 shrink-0 rounded border border-gray-200 object-cover"
            />
          ))}
        </div>
      )}

      <p className="whitespace-pre-wrap text-gray-700">{auction.description}</p>

      <div className="flex items-baseline justify-between rounded border border-gray-200 p-4">
        <div>
          <p className="text-sm text-gray-500">Current price</p>
          <p className="text-2xl font-bold">{formatCents(auction.currentPriceCents)}</p>
        </div>
        <div className="text-right">
          <p className="text-sm text-gray-500">{auction.status === 'ACTIVE' ? 'Time remaining' : 'Scheduled end'}</p>
          <p className="font-medium">
            {auction.status === 'ACTIVE'
              ? timeRemaining
              : auction.endTime
                ? new Date(auction.endTime).toLocaleString()
                : '—'}
          </p>
        </div>
      </div>

      {auction.status === 'ACTIVE' && (
        <>
          {authStatus === 'authenticated' && accessToken && user && user.id !== auction.sellerId && (
            <BidForm auctionId={auctionId} currentPriceCents={auction.currentPriceCents} accessToken={accessToken} />
          )}
          {authStatus === 'authenticated' && user && user.id === auction.sellerId && (
            <p className="text-sm text-gray-500">You can&apos;t bid on your own auction.</p>
          )}
          {authStatus === 'anonymous' && (
            <p className="text-sm text-gray-500">
              <Link href="/login" className="underline">
                Log in
              </Link>{' '}
              to place a bid.
            </p>
          )}
        </>
      )}

      {/* Deliberately no direct link to THIS auction's specific order —
          the auction row has no orderId (ADR-0023 never added one; Order
          is looked up the other way, by auctionId, only when needed) and
          adding that lookup here just to link one row would couple this
          already-busy page to the Orders domain for a single click-through.
          "My orders" (NavBar) is one click away and lists every order a
          participant has, sorted newest first — this just tells a
          participant to look there. */}
      {auction.status === 'ENDED' &&
        user &&
        (user.id === auction.sellerId || bids.some((bid) => bid.bidderId === user.id)) && (
          <p className="text-sm text-gray-500">
            This auction has ended. Check{' '}
            <Link href="/orders" className="underline">
              My orders
            </Link>{' '}
            for the outcome.
          </p>
        )}

      <section>
        <h2 className="mb-2 text-lg font-medium">Bid history</h2>
        {bids.length === 0 && <p className="text-sm text-gray-500">No bids yet.</p>}
        <ul className="flex flex-col gap-1">
          {bids.map((bid) => (
            <li key={bid.id} className="flex justify-between text-sm">
              <span className="text-gray-500">{new Date(bid.createdAt).toLocaleString()}</span>
              <span className="font-medium">{formatCents(bid.amountCents)}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
