// The Groq-backed features, with the network faked. No database, no real key.
import request from 'supertest';
import { createApp } from '../../src/app';
import { env } from '../../src/config/env';
import { toImageUrl } from '../../src/infrastructure/ai/groqClient';
import { groqValuationProvider } from '../../src/infrastructure/ai/groqValuationProvider';
import { signAccessToken } from '../../src/infrastructure/security/tokens';

const app = createApp();
const token = signAccessToken({ sub: '00000000-0000-4000-8000-000000000001', role: 'USER' });
const realFetch = global.fetch;

function reply(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
}

const listing = {
  title: 'Old watch',
  description: 'A watch.',
  category: 'WATCHES',
  condition: 'GOOD',
};

const goodSuggestion = {
  title: 'Steel wristwatch',
  description: 'A steel wristwatch.',
  category: 'WATCHES',
  condition: 'not-a-condition',
  conditionReason: 'Light wear.',
  missingDetails: [{ label: 'Year', why: 'Buyers price by year.' }, { nonsense: true }],
  photoTips: ['Show the case back', 42],
  concerns: [],
};

const valuationInput = {
  title: 'Old watch',
  description: 'A watch.',
  category: 'WATCHES',
  condition: 'GOOD',
  imageUrls: [],
};

// jest.setup.ts has already parsed the environment by now (with the key
// blanked), so the parsed value is what a test has to change.
beforeAll(() => {
  env.GROQ_API_KEY = 'test-key-not-real';
});

let fetchMock: jest.Mock;
beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterAll(() => {
  global.fetch = realFetch;
});

const post = (body: object) =>
  request(app).post('/api/v1/ai/listing-suggestions').set('Authorization', `Bearer ${token}`).send(body);

describe('POST /api/v1/ai/listing-suggestions', () => {
  it('requires sign-in', async () => {
    const res = await request(app).post('/api/v1/ai/listing-suggestions').send(listing);
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an empty draft without calling the model', async () => {
    const res = await post({ ...listing, title: '' });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an image outside our storage (the server would fetch it)', async () => {
    const res = await post({ ...listing, images: ['http://169.254.169.254/latest/meta-data'] });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a cleaned suggestion and sends the key only in the header', async () => {
    fetchMock.mockResolvedValueOnce(reply(JSON.stringify(goodSuggestion)));
    const res = await post(listing);

    expect(res.status).toBe(200);
    expect(res.body.suggestion.title).toBe('Steel wristwatch');
    // Invalid enum and malformed list entries are dropped, not fatal.
    expect(res.body.suggestion.condition).toBeNull();
    expect(res.body.suggestion.missingDetails).toEqual([{ label: 'Year', why: 'Buyers price by year.' }]);
    expect(res.body.suggestion.photoTips).toEqual(['Show the case back']);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${env.GROQ_BASE_URL}/chat/completions`);
    expect(init.headers.authorization).toBe('Bearer test-key-not-real');
    expect(init.body).not.toContain('test-key-not-real');
    expect(JSON.stringify(res.body)).not.toContain('test-key-not-real');
  });

  it('retries once on unreadable output, then gives a clear 503', async () => {
    fetchMock.mockImplementation(async () => reply('not json'));
    const res = await post(listing);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('AI_UNAVAILABLE');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry when rate limited, and does not leak the provider reply', async () => {
    fetchMock.mockResolvedValueOnce(new Response('org_secret_123 over quota', { status: 429 }));
    const res = await post(listing);
    expect(res.status).toBe(429);
    expect(JSON.stringify(res.body)).not.toContain('org_secret_123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Groq valuation', () => {
  it('converts to cents and keeps the estimate inside the range', async () => {
    fetchMock.mockResolvedValueOnce(
      reply(
        JSON.stringify({
          estimatedValueUsd: 100,
          priceRangeLowUsd: 120,
          priceRangeHighUsd: 90,
          confidence: 0.4,
          explanation: 'Because.',
        }),
      ),
    );
    const result = await groqValuationProvider.valuate(valuationInput);
    expect(result).toMatchObject({
      estimatedValueCents: 10_000,
      priceRangeLowCents: 10_000,
      priceRangeHighCents: 10_000,
      model: env.GROQ_MODEL,
    });
  });

  it('reports a rejected key as a safe message', async () => {
    fetchMock.mockResolvedValueOnce(new Response('invalid api key gsk_abc', { status: 401 }));
    await expect(groqValuationProvider.valuate(valuationInput)).rejects.toThrow('The AI service rejected the request.');
  });
});

describe('toImageUrl', () => {
  it('passes a public HTTPS image through without downloading it', async () => {
    await expect(toImageUrl('https://cdn.example.com/a.webp')).resolves.toBe('https://cdn.example.com/a.webp');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('inlines a local image', async () => {
    fetchMock.mockResolvedValueOnce(new Response(Buffer.from('abc'), { headers: { 'content-type': 'image/png' } }));
    await expect(toImageUrl('http://127.0.0.1:9190/auctionx-media/a.png')).resolves.toBe('data:image/png;base64,YWJj');
  });
});
