import type { AuctionCategory } from '@prisma/client';

// Pre-publication review rules (ADR-0041). Pure functions of explicit
// inputs, deliberately not reading env themselves, so every branch is
// unit-testable regardless of the process-wide env (NODE_ENV is fixed per
// test run, same reason csrf.ts takes nodeEnv as a parameter).
//
//   off       Legacy behaviour: sellers publish and start their own
//             auctions immediately. Used by the test suite.
//   untrusted Listings are reviewed unless the seller is trusted AND the
//             category is low-risk. Because nobody is trusted by default,
//             this starts out as "review everything" and loosens only when
//             an admin marks a seller trusted.
export type ReviewMode = 'off' | 'untrusted';

// Read at call time rather than captured from the env singleton at import:
// tests switch it per file, and config/env.ts has already validated the value
// at boot (fail-fast), so anything that isn't 'off' is 'untrusted'.
export function currentReviewMode(): ReviewMode {
  return process.env.AUCTION_REVIEW_MODE === 'off' ? 'off' : 'untrusted';
}

// Categories where a convincing fake costs a buyer real money and where
// paperwork (certificate, receipt, provenance) is the normal way to back a
// claim. These are always reviewed, even for a trusted seller, and require at
// least one supporting document to be submitted.
export const HIGH_RISK_CATEGORIES: ReadonlySet<AuctionCategory> = new Set<AuctionCategory>([
  'WATCHES',
  'JEWELRY',
  'ART',
  'COINS_AND_CURRENCY',
]);

export function requiresDocuments(category: AuctionCategory): boolean {
  return HIGH_RISK_CATEGORIES.has(category);
}

export function requiresReview(
  mode: ReviewMode,
  seller: { trustedSeller: boolean },
  category: AuctionCategory,
): boolean {
  if (mode === 'off') return false;
  return !seller.trustedSeller || HIGH_RISK_CATEGORIES.has(category);
}
