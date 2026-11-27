# 0046 — Groq for the listing assistant and AI valuation

## Context

Section 20 (valuation) and Section 23 (listing assistant). ADR-0032 chose a
self-hosted Ollama model: free, but its price estimates were very poor, no free
deploy target can run it, and the listing assistant built on it was removed
because a call took over a minute.

## Problem

Both features need a vision model that is fast enough to wait for and can run
in production, without putting AI on any critical path (Section 24).

## Options Considered

1. **Larger local model** — better quality, still no way to deploy it, slower.
2. **Hosted API (Groq)** — fast, deployable, has a no-cost tier; sends seller
   data to a third party and depends on quotas and model availability.
3. **Other hosted APIs** — comparable; Groq was the developer's choice.

## Decision

- Groq's OpenAI-compatible endpoint, called with `fetch` (one endpoint does not
  justify an SDK dependency).
- **Valuation** stays asynchronous (Kafka consumer). A `ValuationProvider` seam
  already existed: Groq is used when `GROQ_API_KEY` is set, Ollama otherwise.
  Up to five recent sales in the same category are given to the model and shown
  to the seller.
- **Listing assistant** is synchronous (`POST /api/v1/ai/listing-suggestions`):
  a person is waiting, it takes seconds, nothing depends on it. It only
  proposes; the seller accepts each change.

## Why / safeguards

- The key is server-only configuration. Provider error bodies are logged (keys
  masked) and never returned to clients.
- Seller text and photos are untrusted: the prompt says to treat them as data,
  and every reply is schema-validated. The output cannot change anything by
  itself, which is the real protection against prompt injection.
- Image URLs must be our own storage (the server may fetch them: SSRF).
- Quota protection: 8 requests per user per 10 minutes and 60 per hour for the
  whole deployment, a 30 s timeout, no retry on 429, one retry on bad output.

## Tradeoffs

- The default model (`qwen/qwen3.8-27b`) is a **preview** model and can be
  withdrawn at short notice. `GROQ_MODEL` changes it without a code change.
- Prices are model guesses with no live market data; the self-reported
  confidence is not a probability.
- Listing data and up to two photos leave our infrastructure.
- Rate limiting fails open if Redis is down (as elsewhere), so Groq's own
  limits are then the only ceiling.
- Comparable sales can include test listings.

## Consequences

Valuation works in production once the key is set on the API host. Without a key
the assistant is hidden and valuation behaves as before.

## Revisit Conditions

- The preview model is withdrawn, or quota is regularly exhausted.
- Enough real sales exist to price from data instead of from a language model.
