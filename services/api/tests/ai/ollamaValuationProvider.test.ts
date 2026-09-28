import { toCents, toResult } from '../../src/infrastructure/ai/ollamaValuationProvider';

describe('toCents', () => {
  it('converts whole dollars to integer cents', () => {
    expect(toCents(42)).toBe(4200);
  });

  it('rounds fractional cents rather than truncating', () => {
    expect(toCents(19.999)).toBe(2000);
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
