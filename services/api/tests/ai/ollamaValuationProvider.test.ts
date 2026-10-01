import { rawValuationSchema, toCents, toResult } from '../../src/infrastructure/ai/ollamaValuationProvider';

describe('toCents', () => {
  it('converts whole dollars to integer cents', () => {
    expect(toCents(42)).toBe(4200);
  });

  it('rounds fractional cents rather than truncating', () => {
    expect(toCents(19.999)).toBe(2000);
  });
});

describe('rawValuationSchema', () => {
  it('accepts the exact non-Usd-suffixed shape moondream returned live for a real photo (2026-09-30)', () => {
    // Reproduced directly against Ollama: syntactically valid JSON, sane
    // values, but estimatedValue/priceRangeLow/priceRangeHigh instead of
    // the Usd-suffixed names the prompt asked for. Before the
    // preprocess normalization, this exact shape failed schema
    // validation on both the first attempt and the one retry, surfacing
    // to the seller as "Model did not return a parseable response after
    // one retry" even though the data was perfectly usable.
    const result = rawValuationSchema.safeParse({
      estimatedValue: 0.13,
      confidence: 0.68,
      priceRangeLow: 0.13,
      priceRangeHigh: 0.87,
      explanation: 'air nike shoes brown and white with checkered pattern',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        estimatedValueUsd: 0.13,
        priceRangeLowUsd: 0.13,
        priceRangeHighUsd: 0.87,
        confidence: 0.68,
        explanation: 'air nike shoes brown and white with checkered pattern',
      });
    }
  });

  it('still accepts the Usd-suffixed shape the prompt actually asks for', () => {
    const result = rawValuationSchema.safeParse({
      estimatedValueUsd: 50,
      priceRangeLowUsd: 40,
      priceRangeHighUsd: 60,
      confidence: 0.7,
      explanation: 'ok',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a response missing the value entirely under either naming', () => {
    const result = rawValuationSchema.safeParse({
      confidence: 0.7,
      explanation: 'ok',
    });
    expect(result.success).toBe(false);
  });
});

describe('toResult', () => {
  it('passes through an already-consistent range unchanged', () => {
    const result = toResult(
      { estimatedValueUsd: 50, priceRangeLowUsd: 40, priceRangeHighUsd: 60, confidence: 0.7, explanation: 'ok' },
      'moondream',
    );
    expect(result).toEqual({
      estimatedValueCents: 5000,
      priceRangeLowCents: 4000,
      priceRangeHighCents: 6000,
      confidence: 0.7,
      explanation: 'ok',
      model: 'moondream',
    });
  });

  it('widens the range to include the estimate when the model reports an inconsistent low bound', () => {
    // A small local model has no guaranteed internal consistency — this
    // simulates it reporting a "low" bound above its own point estimate.
    const result = toResult(
      { estimatedValueUsd: 50, priceRangeLowUsd: 55, priceRangeHighUsd: 60, confidence: 0.5, explanation: 'x' },
      'moondream',
    );
    expect(result.priceRangeLowCents).toBe(5000);
    expect(result.priceRangeLowCents).toBeLessThanOrEqual(result.estimatedValueCents);
  });

  it('widens the range to include the estimate when the model reports an inconsistent high bound', () => {
    const result = toResult(
      { estimatedValueUsd: 50, priceRangeLowUsd: 40, priceRangeHighUsd: 45, confidence: 0.5, explanation: 'x' },
      'moondream',
    );
    expect(result.priceRangeHighCents).toBe(5000);
    expect(result.priceRangeHighCents).toBeGreaterThanOrEqual(result.estimatedValueCents);
  });

  it('falls back to a placeholder when the model returns a blank explanation', () => {
    // Confirmed live against a real moondream response: it reliably returns
    // valid JSON matching this schema but sometimes leaves explanation "".
    const result = toResult(
      { estimatedValueUsd: 50, priceRangeLowUsd: 40, priceRangeHighUsd: 60, confidence: 0.2, explanation: '' },
      'moondream',
    );
    expect(result.explanation).toBe('No explanation was provided by the model.');
  });
});
