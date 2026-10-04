// Shown on every page, always. AuctionX is a portfolio project: payments go
// through Stripe's TEST mode (the API refuses to boot with a live key, see
// services/api/src/config/env.ts), so no real card is ever charged. This makes
// that obvious to anyone who lands on the site.
export function TestModeBanner() {
  return (
    <div className="border-b-2 border-line bg-cream-2 px-4 py-1.5 text-center text-xs font-semibold">
      Demo project · payments run in test mode and no real money moves. Please don’t enter a real card.
    </div>
  );
}
