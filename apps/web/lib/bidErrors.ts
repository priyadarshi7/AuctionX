import type { ApiError } from './apiClient';

// Translates the backend's error codes (services/api/src/modules/bids/
// service.ts) into copy a bidder can act on. The raw backend message for
// VALIDATION_ERROR literally says "...current price of 6000 cents" — exact
// and correct for a machine, not for a person reading a bid form, so this
// is the one place that gap gets closed rather than shown to a user as-is.
export function getBidErrorMessage(error: ApiError): string {
  switch (error.code) {
    case 'VALIDATION_ERROR':
      return 'Your bid must be higher than the current price.';
    case 'AUCTION_NOT_ACTIVE':
      return 'This auction is no longer accepting bids.';
    case 'AUCTION_SCHEDULE_EXPIRED':
      return "This auction's time has run out.";
    case 'FORBIDDEN':
      return 'You cannot bid on your own auction.';
    default:
      return error.message;
  }
}
