'use client';

import { IconPhoto, IconSearch } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Dialog, DialogContent } from '@/components/wensity/dialog';
import { ApiError } from '@/lib/apiClient';
import { CATEGORY_DISPLAY, CATEGORY_ORDER } from '@/lib/categoryDisplay';
import { formatCents } from '@/lib/format';
import { lotRef } from '@/lib/lot';
import { searchAuctionsRequest } from '@/lib/search';
import { useDebouncedValue } from '@/lib/useDebouncedValue';

type Entry = { key: string; href: string; title: string; detail: string; image?: string; price?: string };

// Ctrl/⌘ + K from anywhere: search the catalogue, or jump to a department.
// Arrow keys move, Enter opens.
export function CatalogueSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [cursor, setCursor] = useState(0);
  const term = useDebouncedValue(text.trim(), 200);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const search = useQuery({
    queryKey: ['auctions', 'palette', term],
    queryFn: () => searchAuctionsRequest({ q: term, limit: 6 }),
    enabled: open && term !== '',
  });

  const entries: Entry[] =
    term === ''
      ? CATEGORY_ORDER.map((c) => ({
          key: c,
          href: `/auctions?category=${c}`,
          title: CATEGORY_DISPLAY[c].label,
          detail: CATEGORY_DISPLAY[c].tagline,
        }))
      : [
          ...(search.data?.results ?? []).map((lot) => ({
            key: lot.id,
            href: `/auctions/${lot.id}`,
            title: lot.title,
            detail: `Lot ${lotRef(lot.id)} · ${CATEGORY_DISPLAY[lot.category].label}`,
            image: lot.images[0],
            price: formatCents(lot.currentPriceCents),
          })),
          {
            key: 'all',
            href: `/auctions?q=${encodeURIComponent(term)}`,
            title: `Search the full catalogue for “${term}”`,
            detail: 'All results, with filters',
          },
        ];
  const active = Math.min(cursor, entries.length - 1);

  const close = () => {
    setOpen(false);
    setText('');
    setCursor(0);
  };
  const go = (href: string) => {
    close();
    router.push(href);
  };

  const status =
    term === ''
      ? 'Departments'
      : search.isFetching
        ? 'Searching…'
        : search.isError
          ? search.error instanceof ApiError && search.error.code === 'SEARCH_UNAVAILABLE'
            ? 'Search is temporarily unavailable'
            : 'Search failed. Try again.'
          : `${search.data?.total ?? 0} ${search.data?.total === 1 ? 'lot' : 'lots'} found`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search the catalogue"
        aria-keyshortcuts="Control+K Meta+K"
        className="flex h-9 items-center gap-2 border border-transparent px-2 text-muted-foreground transition-colors hover:text-foreground lg:w-56 lg:border-border lg:bg-surface lg:px-3 lg:hover:border-border-strong"
      >
        <IconSearch className="size-4" stroke={1.5} />
        <span className="hidden flex-1 text-left font-serif text-sm italic lg:block">Search the catalogue</span>
        <kbd className="hidden font-mono text-[10px] lg:block">Ctrl K</kbd>
      </button>

      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <DialogContent accessibilityTitle="Search the catalogue" showClose={false} className="max-w-xl overflow-hidden p-0">
          <div className="flex items-center gap-3 border-b-2 border-foreground px-4">
            <IconSearch aria-hidden className="size-5 text-muted-foreground" stroke={1.5} />
            <input
              autoFocus
              role="combobox"
              aria-expanded
              aria-controls="catalogue-results"
              aria-activedescendant={entries[active] ? `palette-${entries[active].key}` : undefined}
              aria-label="Search lots"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setCursor(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setCursor((active + 1) % entries.length);
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setCursor((active - 1 + entries.length) % entries.length);
                } else if (event.key === 'Enter' && entries[active]) {
                  event.preventDefault();
                  go(entries[active].href);
                }
              }}
              placeholder="Watch, first edition, signed…"
              autoComplete="off"
              className="h-14 w-full bg-transparent font-serif text-xl outline-none placeholder:italic placeholder:text-muted-foreground"
            />
            <kbd className="border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">Esc</kbd>
          </div>

          <p className="eyebrow px-4 pb-1 pt-3" aria-live="polite">
            {status}
          </p>
          <ul id="catalogue-results" role="listbox" className="max-h-[50vh] overflow-y-auto pb-2">
            {entries.map((entry, i) => (
              <li
                key={entry.key}
                id={`palette-${entry.key}`}
                role="option"
                aria-selected={i === active}
                onMouseMove={() => setCursor(i)}
                onClick={() => go(entry.href)}
                className={`flex cursor-pointer items-center gap-3 border-l-2 px-4 py-2.5 ${
                  i === active ? 'border-accent bg-accent-soft' : 'border-transparent'
                }`}
              >
                {entry.price !== undefined &&
                  (entry.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={entry.image} alt="" className="size-10 object-cover" />
                  ) : (
                    <span className="flex size-10 items-center justify-center bg-surface-muted">
                      <IconPhoto aria-hidden className="size-4 text-muted-foreground" stroke={1.2} />
                    </span>
                  ))}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-serif text-base">{entry.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{entry.detail}</span>
                </span>
                {entry.price && <span className="figures text-base">{entry.price}</span>}
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
