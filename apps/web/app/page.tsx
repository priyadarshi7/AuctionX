'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CATEGORY_DISPLAY, CATEGORY_ORDER } from '@/lib/categoryDisplay';
import type { AuctionCategory } from '@/lib/types/auction';
import { useAuthStore } from '@/store/authStore';
import { Faq } from './components/home/Faq';
import { Hero } from './components/home/Hero';
import { HowItWorks, type Role } from './components/home/HowItWorks';
import { LiveAuctions } from './components/home/LiveAuctions';
import { useHomeSale } from './components/home/useHomeSale';
import { Reveal } from './components/Reveal';

export default function Home() {
  const router = useRouter();
  const status = useAuthStore((state) => state.status);
  const signedIn = status === 'authenticated';

  // Lifted here so the department index can drive the ledger above it.
  const [category, setCategory] = useState<AuctionCategory | ''>('');

  // Unfiltered query, shared (deduped) with the ledger's "All" state.
  const sale = useHomeSale('');

  // Lifted so the empty hero can open the sellers' conditions.
  const [role, setRole] = useState<Role>('buy');

  // With nothing listed at all, the ledger would only repeat the hero.
  const nothingListed = !sale.isLoading && !sale.isError && sale.state === 'empty';

  // Smooth scroll is skipped under reduced motion.
  const scrollTo = (id: string) => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById(id)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  };

  // Choosing a department filters the ledger in place and scrolls to it; with
  // no ledger on the page it opens that department in the catalogue.
  const jumpToCategory = (next: AuctionCategory) => {
    if (nothingListed) {
      router.push(`/auctions?category=${next}`);
      return;
    }
    setCategory(next);
    scrollTo('live');
  };

  const showSellingRules = () => {
    setRole('sell');
    scrollTo('conditions');
  };

  return (
    <main className="flex-1">
      <Hero
        lots={sale.lots}
        state={sale.state}
        loading={sale.isLoading}
        failed={sale.isError}
        signedIn={signedIn}
        onHowSelling={showSellingRules}
      />

      {!nothingListed && <LiveAuctions category={category} onCategoryChange={setCategory} />}

      <Reveal>
        <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <h2 className="border-b-2 border-foreground pb-4 text-3xl font-medium tracking-tight">Departments</h2>

          {/* Set like a contents page: name, dot leader, what's in it. */}
          <ul className="grid gap-x-14 md:grid-cols-2">
            {CATEGORY_ORDER.map((c) => {
              const { label, tagline } = CATEGORY_DISPLAY[c];
              return (
                <li key={c} className="border-b border-border">
                  <button
                    type="button"
                    onClick={() => jumpToCategory(c)}
                    className="group flex w-full flex-col py-4 text-left focus-visible:-outline-offset-2"
                  >
                    <span className="flex w-full items-baseline gap-3">
                      <span className="font-serif text-2xl transition-colors group-hover:italic group-hover:text-accent">
                        {label}
                      </span>
                      <span aria-hidden className="leader" />
                      <span aria-hidden className="font-serif text-xl transition-transform group-hover:translate-x-1">
                        →
                      </span>
                    </span>
                    <span className="mt-0.5 text-xs text-muted-foreground">{tagline}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      </Reveal>

      <Reveal>
        <HowItWorks signedIn={signedIn} role={role} onRoleChange={setRole} />
      </Reveal>

      <Reveal>
        <Faq />
      </Reveal>
    </main>
  );
}
