const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

// Mirrors services/api's structured error envelope (middleware/errors.ts):
// { error: { code, message, requestId, details? } }. Keeping this shape in
// sync with the backend by hand for now, same accepted duplication as the
// Zod validation schemas — see lib/validation/auth.ts's comment.
type ApiErrorBody = {
  error: { code: string; message: string; requestId?: string; details?: unknown };
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type ApiFetchOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  accessToken?: string | null;
  query?: Record<string, string | number | undefined>;
};

function buildQueryString(query: ApiFetchOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

// credentials: 'include' on every call, not just auth ones — the refresh
// cookie is httpOnly and scoped to /api/v1/auth (services/api's
// controller.ts) regardless of what this client sends, so it costs nothing
// to always include it and avoids a second code path to remember.
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}${buildQueryString(options.query)}`, {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const data: unknown = await res.json().catch(() => undefined);

  if (!res.ok) {
    const body = data as ApiErrorBody | undefined;
    throw new ApiError(
      res.status,
      body?.error.code ?? 'UNKNOWN_ERROR',
      body?.error.message ?? 'Something went wrong. Please try again.',
      body?.error.details,
    );
  }

  return data as T;
}
