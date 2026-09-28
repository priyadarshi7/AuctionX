export const DURATION_LABELS: Record<string, string> = {
  '1': '1 hour',
  '6': '6 hours',
  '24': '24 hours',
  '72': '3 days',
};

// Defined at module scope, not inline in a component's event handler: the
// react-hooks/purity lint rule flags any lexical Date.now() call inside a
// component function on sight, even one that only runs inside a click
// handler and never during render (see app/auctions/new/page.tsx's original
// comment on this, WEB-002). Shared here now that a second page
// (my-auctions) needs the identical computation — duplicating it would risk
// the two copies drifting, for no benefit.
export function computeEndTime(durationHours: string): string {
  return new Date(Date.now() + Number(durationHours) * 60 * 60 * 1000).toISOString();
}
