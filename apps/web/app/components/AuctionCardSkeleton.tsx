// Same outline and proportions as AuctionCard so the grid doesn't jump
// when real cards replace it.
export function AuctionCardSkeleton() {
  return (
    <div aria-hidden className="flex animate-pulse flex-col overflow-hidden rounded-2xl border-2 border-line bg-white shadow-hard-sm">
      <div className="aspect-square w-full border-b-2 border-line bg-cream-2" />
      <div className="flex flex-col gap-2 p-3">
        <div className="h-4 w-4/5 rounded-full bg-cream-2" />
        <div className="h-3 w-1/3 rounded-full bg-cream-2" />
        <div className="h-5 w-1/2 rounded-full bg-cream-2" />
      </div>
    </div>
  );
}
