'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '@/lib/apiClient';
import { listAuctionsRequest } from '@/lib/auctions';
import { CATEGORY_DISPLAY, CATEGORY_ORDER, THEME_CLASSES } from '@/lib/categoryDisplay';
import { searchAuctionsRequest, type SearchAuctionResult } from '@/lib/search';
import type { AuctionCategory, AuctionStatus } from '@/lib/types/auction';
import { AuctionCard } from '../components/AuctionCard';
import { AuctionCardSkeleton } from '../components/AuctionCardSkeleton';
import { Button, ButtonLink } from '../components/ui/Button';
import { inputClass } from '../components/ui/Field';
import { PageHeader, PageMessage } from '../components/ui/Page';

// ---- URL <-> filter state ------------------------------------------------
// Every filter lives in the query string, so a browse view is shareable,
// survives refresh, and works with the back button. Defaults are omitted
// from the URL to keep it clean.

const STATUS_OPTIONS = [
  { id: 'all', label: 'All', api: undefined },
  { id: 'live', label: 'Live', api: 'ACTIVE' },
  { id: 'upcoming', label: 'Upcoming', api: 'PUBLISHED' },
  { id: 'ended', label: 'Ended', api: 'ENDED' },
] as const satisfies readonly { id: string; label: string; api: AuctionStatus | undefined }[];
type StatusId = (typeof STATUS_OPTIONS)[number]['id'];

const SORT_OPTIONS = [
  { id: 'newest', label: 'Newest' },
  { id: 'ending', label: 'Ending soonest' },
  { id: 'price-asc', label: 'Price: low to high' },
  { id: 'price-desc', label: 'Price: high to low' },
] as const;
type SortId = (typeof SORT_OPTIONS)[number]['id'];

function parseCategory(value: string | null): AuctionCategory | '' {
  return value && value in CATEGORY_DISPLAY ? (value as AuctionCategory) : '';
}
function parseStatus(value: string | null): StatusId {
  return STATUS_OPTIONS.some((s) => s.id === value) ? (value as StatusId) : 'all';
}
function parseSort(value: string | null): SortId {
  return SORT_OPTIONS.some((s) => s.id === value) ? (value as SortId) : 'newest';
}

// Sorting is done client-side over the pages loaded so far — true for both
// the browse path (cursor pagination, ADR-0008) and the search path (page
// pagination, ADR-0029): neither backend endpoint takes a sort parameter,
// so "ending soonest"/"price" sort the results fetched so far, while
// "newest" for browse and relevance for search are already correct
// server-side order. The UI says so whenever more pages remain.
function sortAuctions<T extends { currentPriceCents: number; endTime: string | null }>(
  auctions: T[],
  sort: SortId,
): T[] {
  if (sort === 'newest') return auctions;
  const copy = [...auctions];
  if (sort === 'price-asc') return copy.sort((a, b) => a.currentPriceCents - b.currentPriceCents);
  if (sort === 'price-desc') return copy.sort((a, b) => b.currentPriceCents - a.currentPriceCents);
  const end = (a: T) => (a.endTime ? new Date(a.endTime).getTime() : Number.POSITIVE_INFINITY);
  return copy.sort((a, b) => end(a) - end(b));
}

export function BrowseView() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const category = parseCategory(searchParams.get('category'));
  const statusId = parseStatus(searchParams.get('status'));
  const sort = parseSort(searchParams.get('sort'));
  const urlQuery = searchParams.get('q') ?? '';

  const [query, setQuery] = useState(urlQuery);

  const setParams = useCallback(
    (changes: Record<string, string>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(changes)) {
        if (value === '' || value === 'all' || value === 'newest') next.delete(key);
        else next.set(key, value);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  // Debounced write of the search box to the URL.
  useEffect(() => {
    if (query === urlQuery) return;
    const timer = setTimeout(() => setParams({ q: query.trim() }), 300);
    return () => clearTimeout(timer);
  }, [query, urlQuery, setParams]);

  const statusApi = STATUS_OPTIONS.find((s) => s.id === statusId)!.api;
  const hasQuery = urlQuery.trim() !== '';
  const SEARCH_PAGE_SIZE = 20;

  // Maps directly onto the backend's keyset pagination (ADR-0008): each
  // page's nextCursor becomes the next page's cursor param. No offset math
  // anywhere — the same correctness reason applies to a live "newest first"
  // feed on the frontend as it did on the backend. Only active with no text
  // query — `enabled: !hasQuery` rather than tearing this query down, so
  // clearing the search box resumes right where browsing left off instead
  // of re-fetching from scratch.
  const browseQuery = useInfiniteQuery({
    queryKey: ['auctions', 'list', 'browse', category, statusId],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      listAuctionsRequest({ category: category || undefined, status: statusApi, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: !hasQuery,
  });

  // The real thing (ADR-0029) — relevance-ranked full-text search against
  // OpenSearch, covering the WHOLE dataset, not just whatever's been
  // paginated in so far. Page-based (`from`/`size`), not cursor-based: a
  // genuinely separate, simpler read path from browse, matching the
  // backend's own pagination choice for this endpoint. `total` (which the
  // browse endpoint never returns) drives `hasNextPage` exactly, instead of
  // the "fetch one extra row" heuristic keyset pagination uses.
  const searchQuery = useInfiniteQuery({
    queryKey: ['auctions', 'search', urlQuery, category, statusId],
    queryFn: ({ pageParam }: { pageParam: number }) =>
      searchAuctionsRequest({
        q: urlQuery,
        category: category || undefined,
        status: statusApi,
        page: pageParam,
        limit: SEARCH_PAGE_SIZE,
      }),
    initialPageParam: 1,
    getNextPageParam: (lastPage, allPages) => {
      const loadedSoFar = allPages.reduce((sum, page) => sum + page.results.length, 0);
      return loadedSoFar < lastPage.total ? allPages.length + 1 : undefined;
    },
    enabled: hasQuery,
  });

  const active = hasQuery ? searchQuery : browseQuery;
  const { fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, isError, error, refetch } = active;
  const searchUnavailable = hasQuery && error instanceof ApiError && error.code === 'SEARCH_UNAVAILABLE';

  const loaded: SearchAuctionResult[] = useMemo(() => {
    if (hasQuery) return searchQuery.data?.pages.flatMap((page) => page.results) ?? [];
    return browseQuery.data?.pages.flatMap((page) => page.auctions) ?? [];
  }, [hasQuery, searchQuery.data, browseQuery.data]);
  const searchTotal = hasQuery ? searchQuery.data?.pages[0]?.total : undefined;

  // Auto-load the next page as the sentinel nears the viewport; the
  // "Load more" button below stays as the keyboard / no-observer fallback.
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasNextPage) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: '400px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // No client-side substring filtering anymore — `loaded` already IS the
  // right set (relevance-matched by the real backend when hasQuery, or
  // every browsed row otherwise). Sort is still applied client-side, since
  // neither backend endpoint takes a sort parameter.
  const visible = useMemo(() => sortAuctions(loaded, sort), [loaded, sort]);

  const filtersActive = category !== '' || statusId !== 'all' || urlQuery !== '' || sort !== 'newest';
  const clearAll = () => {
    setQuery('');
    router.replace(pathname, { scroll: false });
  };
  // Only SORT still has a "loaded so far" caveat — search itself now
  // covers the whole dataset (searchTotal), not just what's paginated in.
  const localOnly = sort !== 'newest' && hasNextPage;

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
      <PageHeader
        title="Browse auctions"
        subtitle="Find something rare, watch it live, and bid before the clock runs out."
      />

      {/* Toolbar */}
      <div className="mb-6 flex flex-col gap-4 rounded-2xl border-2 border-ink bg-white p-4 shadow-hard-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <div className="relative flex-1">
            <label htmlFor="browse-search" className="sr-only">
              Search auctions by title or description
            </label>
            <span aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink/60">
              &#9906;
            </span>
            <input
              id="browse-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search auctions — try a keyword from the title or description"
              autoComplete="off"
              className={`${inputClass(false)} pl-9`}
            />
          </div>

          <div role="group" aria-label="Auction status" className="flex rounded-full border-2 border-ink bg-cream p-1">
            {STATUS_OPTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={statusId === s.id}
                onClick={() => setParams({ status: s.id })}
                className={`rounded-full px-3.5 py-1 text-sm font-semibold transition-colors ${
                  statusId === s.id ? 'bg-yellow' : 'hover:bg-cream-2'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          <div>
            <label htmlFor="browse-sort" className="sr-only">
              Sort auctions
            </label>
            <select
              id="browse-sort"
              value={sort}
              onChange={(event) => setParams({ sort: event.target.value })}
              className={`${inputClass(false)} w-full py-2 text-sm md:w-auto`}
            >
              {SORT_OPTIONS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div
          role="group"
          aria-label="Filter by category"
          className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0"
        >
          <button
            type="button"
            aria-pressed={category === ''}
            onClick={() => setParams({ category: '' })}
            className={`shrink-0 rounded-full border-2 border-ink px-4 py-1.5 text-sm font-semibold transition-colors ${
              category === '' ? 'bg-ink text-cream' : 'bg-white hover:bg-cream-2'
            }`}
          >
            All categories
          </button>
          {CATEGORY_ORDER.map((c) => {
            const display = CATEGORY_DISPLAY[c];
            const theme = THEME_CLASSES[display.theme];
            const active = category === c;
            return (
              <button
                key={c}
                type="button"
                aria-pressed={active}
                onClick={() => setParams({ category: active ? '' : c })}
                className={`shrink-0 rounded-full border-2 border-ink px-4 py-1.5 text-sm font-semibold transition-colors ${
                  active ? `${theme.bg} ${theme.text}` : 'bg-white hover:bg-cream-2'
                }`}
              >
                {display.emoji} {display.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Result summary */}
      <div className="mb-4 flex min-h-6 flex-wrap items-center justify-between gap-2 text-sm" aria-live="polite">
        <p className="text-ink/70">
          {isLoading
            ? 'Loading auctions…'
            : (() => {
                // searchTotal is the real, whole-dataset count (ADR-0029) —
                // shown exactly when known, instead of the "+" heuristic
                // browse pagination has to fall back to (it only ever knows
                // "at least this many," via the one-extra-row keyset trick).
                const count = searchTotal ?? visible.length;
                const approximate = searchTotal === undefined && hasNextPage;
                return `${count}${approximate ? '+' : ''} ${count === 1 ? 'auction' : 'auctions'}${
                  hasQuery ? ` for "${urlQuery}"` : category ? ` in ${CATEGORY_DISPLAY[category].label}` : ''
                }`;
              })()}
          {localOnly && ' · sort applies to the auctions loaded so far'}
        </p>
        {filtersActive && (
          <button type="button" onClick={clearAll} className="font-semibold underline underline-offset-4">
            Clear all filters
          </button>
        )}
      </div>

      {isLoading && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4" aria-busy="true">
          {Array.from({ length: 8 }, (_, i) => (
            <AuctionCardSkeleton key={i} />
          ))}
        </div>
      )}

      {isError && (
        <PageMessage
          title={searchUnavailable ? 'Search is temporarily unavailable' : "Couldn't load auctions"}
          body={
            searchUnavailable
              ? 'The search index is down, but the rest of the site is fine — browse by category instead, or try again shortly.'
              : 'Check your connection and try again.'
          }
          action={
            <div className="flex gap-3">
              <Button variant="secondary" size="sm" onClick={() => void refetch()}>
                Try again
              </Button>
              {searchUnavailable && (
                <Button size="sm" onClick={clearAll}>
                  Browse instead
                </Button>
              )}
            </div>
          }
        />
      )}

      {!isLoading && !isError && visible.length === 0 && (
        <PageMessage
          mascotColor="#f5c94b"
          title={filtersActive ? 'Nothing matches those filters' : 'No auctions yet'}
          body={
            filtersActive
              ? hasQuery
                ? 'No auctions match that search. Try a different keyword, or loosen a filter.'
                : hasNextPage
                  ? 'Nothing in the auctions loaded so far. Load more, or loosen a filter.'
                  : 'Try a different category or status, or clear your search.'
              : 'Be the first to list something.'
          }
          action={
            filtersActive ? (
              <div className="flex gap-3">
                {hasNextPage && (
                  <Button variant="secondary" size="sm" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
                    {isFetchingNextPage ? 'Loading…' : 'Load more'}
                  </Button>
                )}
                <Button size="sm" onClick={clearAll}>
                  Clear filters
                </Button>
              </div>
            ) : (
              <ButtonLink href="/auctions/new">Sell an item</ButtonLink>
            )
          }
        />
      )}

      {visible.length > 0 && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {visible.map((auction) => (
            <AuctionCard key={auction.id} auction={auction} />
          ))}
        </div>
      )}

      {isFetchingNextPage && (
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => (
            <AuctionCardSkeleton key={i} />
          ))}
        </div>
      )}

      {hasNextPage && !isLoading && (
        <div ref={sentinelRef} className="mt-8 flex justify-center">
          <Button variant="secondary" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}

      {!hasNextPage && !isLoading && !isError && loaded.length > 0 && (
        <p className="mt-8 text-center text-sm text-ink/60">You&apos;ve seen everything. Check back soon.</p>
      )}
    </main>
  );
}
