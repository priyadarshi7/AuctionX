'use client';

import { CATEGORY_DISPLAY, CATEGORY_ORDER } from '@/lib/categoryDisplay';
import type { AuctionCategory } from '@/lib/types/auction';

function tabClass(active: boolean): string {
  return `shrink-0 whitespace-nowrap border-b-2 pb-2 pt-1 font-serif text-base transition-colors ${
    active
      ? 'border-accent italic text-foreground'
      : 'border-transparent text-muted-foreground hover:border-border-strong hover:text-foreground'
  }`;
}

// The department index, shared by the home ledger and the catalogue.
// Choosing the active department again clears it.
export function CategoryFilter({
  value,
  onChange,
  label,
  className = '',
}: {
  value: AuctionCategory | '';
  onChange: (category: AuctionCategory | '') => void;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`flex gap-x-6 overflow-x-auto border-b border-border ${className}`}
    >
      <button type="button" aria-pressed={value === ''} onClick={() => onChange('')} className={tabClass(value === '')}>
        All departments
      </button>
      {CATEGORY_ORDER.map((category) => {
        const active = value === category;
        return (
          <button
            key={category}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(active ? '' : category)}
            className={tabClass(active)}
          >
            {CATEGORY_DISPLAY[category].label}
          </button>
        );
      })}
    </div>
  );
}
