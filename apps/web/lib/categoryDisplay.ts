import type { AuctionCategory } from './types/auction';

// Presentation-only layer on top of the real backend category enum
// (types/auction.ts, mirroring schema.prisma). Deliberately does NOT
// invent categories the backend doesn't have — "Sneakers" and "Pokémon
// cards" aren't their own AuctionCategory, they're trending examples
// surfaced inside the real COLLECTIBLES category, same as "first editions"
// under BOOKS_AND_MANUSCRIPTS. A `Record<AuctionCategory, ...>` (not a
// partial map) means TypeScript fails the build if a category is ever
// added to the enum and forgotten here.
export type CategoryTheme = 'yellow' | 'pink' | 'ink' | 'cream';

export const CATEGORY_DISPLAY: Record<
  AuctionCategory,
  { label: string; tagline: string; emoji: string; theme: CategoryTheme }
> = {
  COLLECTIBLES: {
    label: 'Collectibles',
    tagline: 'Sneakers, Pokémon cards, funko pops & cult favorites.',
    emoji: '\u{1F45F}',
    theme: 'pink',
  },
  BOOKS_AND_MANUSCRIPTS: {
    label: 'Books & Manuscripts',
    tagline: 'First editions and pages worth owning.',
    emoji: '\u{1F4DA}',
    theme: 'yellow',
  },
  WATCHES: {
    label: 'Watches',
    tagline: 'Vintage faces and grail pieces, one winning bid.',
    emoji: '\u{231A}',
    theme: 'ink',
  },
  ART: {
    label: 'Fine Art',
    tagline: 'Paintings and prints worth a second look.',
    emoji: '\u{1F3A8}',
    theme: 'cream',
  },
  JEWELRY: {
    label: 'Jewelry',
    tagline: 'Rings and chains people actually fight over.',
    emoji: '\u{1F48D}',
    theme: 'yellow',
  },
  COINS_AND_CURRENCY: {
    label: 'Coins & Currency',
    tagline: 'Rare mints and notes for the patient collector.',
    emoji: '\u{1FA99}',
    theme: 'pink',
  },
  MEMORABILIA: {
    label: 'Memorabilia',
    tagline: 'Signed, game-worn, one-of-one.',
    emoji: '\u{1F3C6}',
    theme: 'ink',
  },
  OTHER: {
    label: 'Everything Else',
    tagline: "If it's rare and someone wants it, it's here.",
    emoji: '\u{2728}',
    theme: 'cream',
  },
};

// Fixed display order (not enum declaration order) — leads with the two
// categories that actually cover the user's requested "trending" examples
// (sneakers/cards under Collectibles, then Books) rather than an arbitrary
// schema order.
export const CATEGORY_ORDER: AuctionCategory[] = [
  'COLLECTIBLES',
  'BOOKS_AND_MANUSCRIPTS',
  'WATCHES',
  'ART',
  'JEWELRY',
  'COINS_AND_CURRENCY',
  'MEMORABILIA',
  'OTHER',
];

// Tailwind class names must appear as literal strings somewhere in source
// for the compiler to pick them up — this table exists so themed classes
// stay literal (not string-concatenated at runtime) while still being
// looked up dynamically by theme name.
export const THEME_CLASSES: Record<CategoryTheme, { bg: string; text: string; border: string }> = {
  yellow: { bg: 'bg-yellow', text: 'text-ink', border: 'border-ink' },
  pink: { bg: 'bg-pink', text: 'text-ink', border: 'border-ink' },
  ink: { bg: 'bg-ink', text: 'text-cream', border: 'border-line' },
  cream: { bg: 'bg-cream-2', text: 'text-ink', border: 'border-ink' },
};
