import { Skeleton } from './ui/Page';

// Same outline and proportions as AuctionCard so the grid doesn't jump
// when real cards replace it.
export function AuctionCardSkeleton() {
  return (
    <div aria-hidden className="flex flex-col">
      <div className="plate">
        <Skeleton className="aspect-square w-full rounded-none" />
      </div>
      <Skeleton className="mt-3 h-3 w-1/2" />
      <Skeleton className="mt-2 h-5 w-4/5" />
      <Skeleton className="mt-4 h-9 w-full" />
    </div>
  );
}
