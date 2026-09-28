const currencyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

// Every price crossing the API is integer cents (ADR-0007) — this is the
// one place that conversion to a human-readable amount happens, so it
// never gets done inconsistently in multiple components.
export function formatCents(cents: number): string {
  return currencyFormatter.format(cents / 100);
}

export function formatCategory(category: string): string {
  return category
    .split('_')
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}
