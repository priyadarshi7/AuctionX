// The seam between Phase 10's valuation flow and any specific model
// provider — same pattern as infrastructure/payments/provider.ts's
// PaymentProvider and infrastructure/email/sender.ts's EmailSender.
// modules/ai's business logic depends only on this interface, never on
// Ollama specifically, so swapping in a cloud provider later (ADR-0032's
// open production-deployment question — see Section 83) touches one new
// implementation file, not modules/ai/consumer.ts or anything upstream.

export type ValuationInput = {
  title: string;
  description: string;
  category: string;
  condition: string;
  // Full public URLs (Auction.images) — the provider is responsible for
  // fetching bytes itself, so this interface stays transport-agnostic (a
  // future cloud provider might accept URLs directly instead of bytes).
  imageUrls: string[];
};

export type ValuationResult = {
  estimatedValueCents: number;
  priceRangeLowCents: number;
  priceRangeHighCents: number;
  // 0..1 — the model's own self-reported confidence, a soft signal, never
  // treated as a statistical guarantee.
  confidence: number;
  explanation: string;
  // Which concrete model produced this (e.g. "moondream") — stored on the
  // AuctionValuation row itself, not assumed from current config, since
  // OLLAMA_VALUATION_MODEL can change between when different rows were
  // generated.
  model: string;
};

// Thrown for ANY failure to produce a usable result — model unreachable,
// timeout, or a response that doesn't parse/validate into ValuationResult.
// modules/ai/consumer.ts catches this (deliberately, see its own comment)
// and stores it as a FAILED valuation rather than letting it propagate to
// Kafka's DLQ handling.
export class ValuationProviderError extends Error {}

export interface ValuationProvider {
  readonly name: string;
  valuate(input: ValuationInput): Promise<ValuationResult>;
}
