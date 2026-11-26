'use client';

import { IconArrowRight, IconPlayerPause, IconPlayerPlay } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { CATEGORY_DISPLAY, CATEGORY_ORDER } from '@/lib/categoryDisplay';
import type { AuctionCategory } from '@/lib/types/auction';
import { Button, ButtonLink } from '../ui/Button';
import { Engraving } from './Engraving';

// What finishes the headline "The first lot could be your …".
const NOUN: Record<AuctionCategory, string> = {
  COLLECTIBLES: 'sneakers',
  BOOKS_AND_MANUSCRIPTS: 'first edition',
  WATCHES: 'watch',
  ART: 'painting',
  JEWELRY: 'ring',
  COINS_AND_CURRENCY: 'rare coin',
  MEMORABILIA: 'trophy',
  OTHER: 'best find',
};

const PLATE_NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];
const TURN_MS = 4500;

// The home spread when nothing is listed: the same layout a real lot gets,
// left blank for the visitor. Everything here is plainly a placeholder — no
// invented lots, prices or clocks.
export function EmptySale({ signedIn, onHowSelling }: { signedIn: boolean; onHowSelling: () => void }) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [held, setHeld] = useState(false);

  const category = CATEGORY_ORDER[index]!;
  const { label, tagline } = CATEGORY_DISPLAY[category];

  // Turns the plates on its own until the visitor picks one or pauses. Holds
  // while hovered or focused, and never starts under reduced motion.
  useEffect(() => {
    if (!playing || held) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const id = setTimeout(() => setIndex((i) => (i + 1) % CATEGORY_ORDER.length), TURN_MS);
    return () => clearTimeout(id);
  }, [index, playing, held]);

  const choose = (next: number) => {
    setIndex(next);
    setPlaying(false);
  };

  return (
    <article className="grid items-center gap-10 py-10 lg:grid-cols-[1fr_0.85fr] lg:gap-14 lg:py-14">
      <div className="order-2 min-w-0 lg:order-1">
        <p className="eyebrow">
          <span className="text-accent">Unclaimed</span> · Lot 001
        </p>
        <h2 className="mt-4 text-4xl font-medium leading-[1.04] tracking-tight sm:text-6xl">
          The first lot could be
          <span className="block">
            your{' '}
            <span key={category} className="word-in inline-block italic text-accent">
              {NOUN[category]}.
            </span>
          </span>
        </h2>
        <p className="mt-4 max-w-md font-serif text-lg italic text-muted-foreground">
          Nothing is listed yet. Add photos and set your price. Some listings are reviewed before they go live.
        </p>

        {/* The figures a live lot shows, left blank. */}
        <dl className="mt-8 flex flex-wrap items-end gap-x-12 gap-y-6 border-t border-border-strong pt-6">
          <div>
            <dt className="eyebrow mb-2">Opening price</dt>
            <dd className="figures flex items-baseline gap-2 text-5xl leading-none">
              $
              <span className="inline-block w-36 border-b-2 border-dotted border-border-strong pb-1 text-center text-lg italic text-muted-foreground">
                you decide
              </span>
            </dd>
          </div>
          <div>
            <dt className="eyebrow mb-2">Closes in</dt>
            <dd aria-label="Not started" className="flex border border-dashed border-border-strong">
              {['Hrs', 'Min', 'Sec'].map((unit, i) => (
                <span key={unit} className={`min-w-16 px-3 py-2 text-center ${i > 0 ? 'border-l border-dashed border-border' : ''}`}>
                  <span className="figures block text-3xl leading-none text-muted-foreground">––</span>
                  <span className="eyebrow mt-1.5 block">{unit}</span>
                </span>
              ))}
            </dd>
          </div>
        </dl>

        <div className="mt-8 flex flex-wrap gap-3">
          <ButtonLink href={signedIn ? '/auctions/new' : '/register'} className="btn-accent">
            {signedIn ? `List your ${NOUN[category]}` : 'Create an account'}
            <IconArrowRight aria-hidden className="size-4" stroke={1.6} />
          </ButtonLink>
          <Button variant="secondary" onClick={onHowSelling}>
            How selling works
          </Button>
        </div>
      </div>

      <div
        className="order-1 mx-auto w-full max-w-md lg:order-2"
        onMouseEnter={() => setHeld(true)}
        onMouseLeave={() => setHeld(false)}
        onFocus={() => setHeld(true)}
        onBlur={() => setHeld(false)}
      >
        <figure className="plate rotate-1 p-3! shadow-2xl transition-transform duration-500 hover:rotate-0">
          <div className="relative border border-border">
            {/* Corner mounts, as a photograph held in an album. */}
            {['left-2 top-2 border-l-2 border-t-2', 'right-2 top-2 border-r-2 border-t-2', 'bottom-2 left-2 border-b-2 border-l-2', 'bottom-2 right-2 border-b-2 border-r-2'].map((corner) => (
              <span key={corner} aria-hidden className={`absolute size-5 border-accent ${corner}`} />
            ))}
            <div className="flex aspect-square items-center justify-center p-10">
              <Engraving key={category} category={category} className="h-full w-full" />
            </div>
          </div>
          <figcaption className="flex items-baseline gap-3 px-1 pt-3">
            <span className="eyebrow">Plate {PLATE_NUMERALS[index]}</span>
            <span aria-hidden className="leader" />
            <span className="font-serif text-lg italic">{label}</span>
          </figcaption>
        </figure>

        <div className="mt-6 flex items-center gap-1" role="group" aria-label="Preview a department">
          {CATEGORY_ORDER.map((c, i) => {
            const { label: name, icon: CategoryIcon } = CATEGORY_DISPLAY[c];
            const active = i === index;
            return (
              <button
                key={c}
                type="button"
                aria-pressed={active}
                aria-label={name}
                title={name}
                onClick={() => choose(i)}
                className={`flex h-10 flex-1 items-center justify-center border-b-2 transition-colors ${
                  active
                    ? 'border-accent text-accent'
                    : 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground'
                }`}
              >
                <CategoryIcon aria-hidden className="size-4.5" stroke={1.3} />
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setPlaying((value) => !value)}
            aria-label={playing ? 'Pause the plates' : 'Turn the plates automatically'}
            className="ml-2 flex size-10 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground motion-reduce:hidden"
          >
            {playing ? (
              <IconPlayerPause aria-hidden className="size-4" stroke={1.4} />
            ) : (
              <IconPlayerPlay aria-hidden className="size-4" stroke={1.4} />
            )}
          </button>
        </div>
        <p className="mt-2 text-center text-xs text-muted-foreground">{tagline}</p>
      </div>
    </article>
  );
}
