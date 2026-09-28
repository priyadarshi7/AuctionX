'use client';

import Link from 'next/link';
import { formatCents } from '@/lib/format';
import type { Auction } from '@/lib/types/auction';
import { useTimeRemaining } from '@/lib/useTimeRemaining';
import { Mascot } from '../Mascot';

// The auction that ends soonest — the most honest "come look at this now".
function Spotlight({ auction }: { auction: Auction }) {
  const timeRemaining = useTimeRemaining(auction.endTime);
  const urgent = /^\d+s$/.test(timeRemaining);

  return (
    <Link
      href={`/auctions/${auction.id}`}
      className="group block w-full max-w-sm rotate-2 rounded-2xl border-2 border-ink bg-white shadow-hard transition-transform hover:-translate-y-1 hover:rotate-0"
    >
      <div className="relative aspect-4/3 overflow-hidden rounded-t-[14px] border-b-2 border-ink bg-cream-2">
        {auction.images[0] ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={auction.images[0]}
            alt={auction.title}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Mascot className="h-24 w-24 opacity-70" />
          </div>
        )}
        <span className="absolute left-3 top-3 rounded-full border-2 border-ink bg-cream px-2.5 py-0.5 text-xs font-semibold">
          Ending soonest
        </span>
      </div>
      <div className="flex flex-col gap-3 p-4">
        <p className="line-clamp-2 font-display text-lg font-bold leading-tight">{auction.title}</p>
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-ink/60">Current bid</p>
            <p className="font-display text-2xl font-extrabold">{formatCents(auction.currentPriceCents)}</p>
          </div>
          <span
            className={`flex items-center gap-1.5 rounded-full border-2 border-ink px-3 py-1 font-display text-sm font-bold tabular-nums ${
              urgent ? 'bg-pink' : 'bg-green'
            }`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-ink" />
            {timeRemaining}
          </span>
        </div>
        <span className="rounded-full border-2 border-ink bg-yellow py-2 text-center font-display font-bold shadow-hard-sm">
          Place a bid
        </span>
      </div>
    </Link>
  );
}

export function Hero({
  auctions,
  loading,
  signedIn,
}: {
  auctions: Auction[];
  loading: boolean;
  signedIn: boolean;
}) {
  const spotlight = [...auctions]
    .filter((a) => a.endTime)
    .sort((a, b) => new Date(a.endTime!).getTime() - new Date(b.endTime!).getTime())[0];

  return (
    <section className="bg-grid relative overflow-hidden border-b-2 border-ink">
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-16 sm:py-24 lg:grid-cols-[1.25fr_1fr]">
        <div className="flex flex-col gap-7">
          <span className="flex w-fit items-center gap-2 rounded-full border-2 border-ink bg-white px-4 py-1.5 text-sm font-semibold shadow-hard-sm">
            <span className="relative flex h-2.5 w-2.5">
              <span className="pulse-ring absolute inline-flex h-full w-full rounded-full bg-green" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full border border-ink bg-green" />
            </span>
            {loading
              ? 'Live bidding, in real time'
              : `${auctions.length}${auctions.length >= 8 ? '+' : ''} auctions live now`}
          </span>

          <h1 className="font-display text-5xl font-extrabold leading-[0.95] tracking-tight sm:text-7xl">
            BID ON THE
            <br />
            <span className="rounded-xl bg-ink px-3 text-cream">STUFF EVERYONE</span>
            <br />
            WANTS.
          </h1>

          <p className="max-w-xl text-lg text-ink/70">
            Sneakers, Pok&eacute;mon cards, rare books, watches &mdash; a real-time auction floor where every bid is
            server-verified and the clock extends if someone snipes.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/auctions"
              className="rounded-full border-2 border-ink bg-yellow px-6 py-3 font-display font-bold shadow-hard transition-transform hover:-translate-y-0.5"
            >
              Browse auctions
            </Link>
            <Link
              href={signedIn ? '/auctions/new' : '/register'}
              className="rounded-full border-2 border-ink bg-white px-6 py-3 font-display font-bold transition-transform hover:-translate-y-0.5"
            >
              {signedIn ? 'Sell an item' : 'Create an account'}
            </Link>
          </div>

          <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm font-medium text-ink/70">
            <li>&#10003; Server-verified bids</li>
            <li>&#10003; 30-second anti-sniping</li>
            <li>&#10003; Instant outbid alerts</li>
          </ul>
        </div>

        <div className="flex justify-center lg:justify-end">
          {loading && (
            <div
              aria-hidden
              className="h-96 w-full max-w-sm rotate-2 animate-pulse rounded-2xl border-2 border-ink bg-white shadow-hard"
            />
          )}
          {!loading && spotlight && <Spotlight auction={spotlight} />}
          {!loading && !spotlight && (
            <div className="flex flex-col items-center gap-4">
              <Mascot className="h-40 w-40" />
              <div className="-rotate-2 rounded-xl border-2 border-ink bg-cream-2 px-4 py-2 font-hand text-xl shadow-hard-sm">
                the floor&apos;s quiet &mdash; list something!
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
