import {
  IconBook,
  IconCoin,
  IconDeviceWatch,
  IconDiamond,
  IconPackage,
  IconPalette,
  IconShoe,
  IconTrophy,
  type Icon,
} from '@tabler/icons-react';
import type { AuctionCategory } from './types/auction';

// Presentation-only layer on top of the real backend category enum
// (types/auction.ts, mirroring schema.prisma). Deliberately does NOT
// invent categories the backend doesn't have — "Sneakers" and "Pokémon
// cards" aren't their own AuctionCategory, they're trending examples
// surfaced inside the real COLLECTIBLES category, same as "first editions"
// under BOOKS_AND_MANUSCRIPTS. A `Record<AuctionCategory, ...>` (not a
// partial map) means TypeScript fails the build if a category is ever
// added to the enum and forgotten here.
export const CATEGORY_DISPLAY: Record<AuctionCategory, { label: string; tagline: string; icon: Icon }> = {
  COLLECTIBLES: { label: 'Collectibles', tagline: 'Sneakers, Pokémon cards and cult favourites', icon: IconShoe },
  BOOKS_AND_MANUSCRIPTS: { label: 'Books & Manuscripts', tagline: 'First editions worth owning', icon: IconBook },
  WATCHES: { label: 'Watches', tagline: 'Vintage faces and grail pieces', icon: IconDeviceWatch },
  ART: { label: 'Fine Art', tagline: 'Paintings and prints', icon: IconPalette },
  JEWELRY: { label: 'Jewelry', tagline: 'Rings, chains and stones', icon: IconDiamond },
  COINS_AND_CURRENCY: { label: 'Coins & Currency', tagline: 'Rare mints and notes', icon: IconCoin },
  MEMORABILIA: { label: 'Memorabilia', tagline: 'Signed, game-worn, one of one', icon: IconTrophy },
  OTHER: { label: 'Everything Else', tagline: 'Rare and wanted', icon: IconPackage },
};

// Fixed display order (not enum declaration order) — leads with the two
// categories that cover the "trending" examples (sneakers/cards under
// Collectibles, then Books) rather than an arbitrary schema order.
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
