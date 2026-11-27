import { apiFetch } from './apiClient';
import type { AuctionCategory, AuctionCondition } from './types/auction';

// Mirrors services/api/src/modules/ai/listingSchema.ts.
export type ListingSuggestion = {
  title: string;
  description: string;
  category: AuctionCategory | null;
  condition: AuctionCondition | null;
  conditionReason: string;
  missingDetails: { label: string; why: string }[];
  photoTips: string[];
  concerns: string[];
  model: string;
};

export type ListingDraft = {
  title: string;
  description: string;
  category: AuctionCategory;
  condition: AuctionCondition;
  images: string[];
};

export function getAiStatusRequest(accessToken: string): Promise<{ listingAssistant: boolean }> {
  return apiFetch<{ listingAssistant: boolean }>('/ai/status', { accessToken });
}

export function suggestListingRequest(
  accessToken: string,
  draft: ListingDraft,
): Promise<{ suggestion: ListingSuggestion }> {
  return apiFetch<{ suggestion: ListingSuggestion }>('/ai/listing-suggestions', {
    method: 'POST',
    body: draft,
    accessToken,
  });
}
