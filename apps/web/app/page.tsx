'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Faq } from './components/home/Faq';
import { Hero } from './components/home/Hero';
import { HowItWorks } from './components/home/HowItWorks';
import { LiveAuctions } from './components/home/LiveAuctions';
import { Marquee } from './components/home/Marquee';
import { useLiveAuctions } from './components/home/useLiveAuctions';
import { Reveal } from './components/Reveal';
import { CATEGORY_DISPLAY, CATEGORY_ORDER, THEME_CLASSES } from '@/lib/categoryDisplay';
import type { AuctionCategory } from '@/lib/types/auction';
import { useAuthStore } from '@/store/authStore';

export default function Home() {
  const status = useAuthStore((state) => state.status);
  const signedIn = status === 'authenticated';

  // Lifted here so a category tile can drive the live grid below it.
  const [category, setCategory] = useState<AuctionCategory | ''>('');

  // Unfiltered query, shared (deduped) with the live grid's "All" state.
  const hero = useLiveAuctions('');

  // Tile click filters the live grid in place and scrolls to it, instead of
  // navigating away. Smooth scroll is skipped under reduced motion.
  const jumpToCategory = (next: AuctionCategory) => {
    setCategory(next);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById('live')?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  };

  return (
    <main className="flex-1">
      <Hero auctions={hero.data?.auctions ?? []} loading={hero.isLoading} signedIn={signedIn} />

      <Marquee />

      <Reveal>
        <section className="mx-auto max-w-6xl px-6 py-16">
          <div className="mb-8 flex items-end justify-between">
            <div>
              <h2 className="font-display text-3xl font-extrabold sm:text-4xl">Shop by category</h2>
              <p className="mt-1 text-ink/60">Tap one to see what&apos;s live in it.</p>
            </div>
            <Link href="/auctions" className="text-sm font-semibold underline underline-offset-4">
              See all
            </Link>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {CATEGORY_ORDER.map((c, index) => {
              const display = CATEGORY_DISPLAY[c];
              const theme = THEME_CLASSES[display.theme];
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => jumpToCategory(c)}
                  className={`group flex min-h-45 flex-col justify-between rounded-2xl border-2 ${theme.border} ${theme.bg} ${theme.text} p-5 text-left shadow-hard-sm transition-transform hover:-translate-y-1 hover:shadow-hard`}
                >
                  <div className="flex w-full items-center justify-between">
                    <span className="text-xs font-bold opacity-70">{String(index + 1).padStart(2, '0')}</span>
                    <span className="text-2xl transition-transform group-hover:scale-125 group-hover:-rotate-6">
                      {display.emoji}
                    </span>
                  </div>
                  <div>
                    <p className="font-display text-xl font-extrabold leading-tight">{display.label}</p>
                    <p className="mt-1 text-sm opacity-80">{display.tagline}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      </Reveal>

      <LiveAuctions category={category} onCategoryChange={setCategory} />

      <Reveal>
        <HowItWorks signedIn={signedIn} />
      </Reveal>

      <Reveal>
        <Faq />
      </Reveal>

      <section className="border-t-2 border-ink bg-ink py-16 text-cream">
        <div className="mx-auto flex max-w-6xl flex-col items-start gap-4 px-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-display text-3xl font-extrabold sm:text-4xl">Ready to bid?</h2>
            <p className="mt-1 text-cream/70">
              {signedIn ? 'The floor is open. Go find your next win.' : 'It takes about a minute to make an account.'}
            </p>
          </div>
          <div className="flex gap-3">
            <Link
              href="/auctions"
              className="rounded-full border-2 border-cream px-6 py-3 font-display font-bold hover:bg-cream/10"
            >
              Browse auctions
            </Link>
            <Link
              href={signedIn ? '/auctions/new' : '/register'}
              className="rounded-full border-2 border-ink bg-yellow px-6 py-3 font-display font-bold text-ink shadow-hard transition-transform hover:-translate-y-0.5"
            >
              {signedIn ? 'Sell an item' : 'Get started'}
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
