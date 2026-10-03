// Keyed by duration in SECONDS. The 30-second option exists so a whole
// auction (bid, anti-sniping extension, close, order) can be tried end to end
// without waiting an hour; it is a normal, valid duration to the backend,
// which only requires an end time in the future. Publishing is three
// sequential requests (set price, publish, start), so a 30s auction has
// roughly 27s left by the time it is live.
export const DURATION_LABELS: Record<string, string> = {
  '30': '30 seconds (for testing)',
  '3600': '1 hour',
  '21600': '6 hours',
  '86400': '24 hours',
  '259200': '3 days',
};

// Defined at module scope, not inline in a component's event handler: the
// react-hooks/purity lint rule flags any lexical Date.now() call inside a
// component function on sight, even one that only runs inside a click
// handler and never during render (see app/auctions/new/page.tsx's original
// comment on this, WEB-002). Shared here now that a second page
// (my-auctions) needs the identical computation — duplicating it would risk
// the two copies drifting, for no benefit.
export function computeEndTime(durationSeconds: string): string {
  return new Date(Date.now() + Number(durationSeconds) * 1000).toISOString();
}
