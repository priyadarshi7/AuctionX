// Shown on every page, always. AuctionX is a portfolio project: payments go
// through Stripe's TEST mode (the API refuses to boot with a live key, see
// services/api/src/config/env.ts), so no real card is ever charged. This makes
// that obvious to anyone who lands on the site.
export function TestModeBanner() {
  return (
    <div className="border-b border-border bg-surface-muted px-4 py-1.5 text-center font-serif text-[13px] italic text-muted-foreground">
      Demo project · payments run in test mode and no real money moves. Please don’t enter a real card.
    </div>
  );
}
