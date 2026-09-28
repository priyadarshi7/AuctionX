import { Suspense } from 'react';
import { AuctionCardSkeleton } from '../components/AuctionCardSkeleton';
import { BrowseView } from './BrowseView';

// useSearchParams (inside BrowseView) opts the subtree out of static
// prerendering, so it must sit under a Suspense boundary; this fallback is
// what a first load shows until the client takes over.
export default function AuctionsPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10" aria-busy="true">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <AuctionCardSkeleton key={i} />
            ))}
          </div>
        </main>
      }
    >
      <BrowseView />
    </Suspense>
  );
}
