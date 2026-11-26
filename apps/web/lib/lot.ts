import type { AuctionCondition } from './types/auction';

// A short, stable catalogue reference taken from the auction's own id. It is
// presentation only — a handle people can read out, not a unique key (two ids
// can share a prefix), so nothing may look an auction up by it.
export function lotRef(id: string): string {
  return id.replace(/-/g, '').slice(0, 4).toUpperCase();
}

export const CONDITION_LABEL: Record<AuctionCondition, string> = {
  NEW: 'New',
  LIKE_NEW: 'Like new',
  GOOD: 'Good',
  FAIR: 'Fair',
  POOR: 'Poor',
};
