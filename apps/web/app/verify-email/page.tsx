import { Suspense } from 'react';
import { VerifyEmailView } from './VerifyEmailView';

// useSearchParams (inside VerifyEmailView, reading ?token=) opts the
// subtree out of static prerendering — same reasoning/pattern as
// app/auctions/page.tsx.
export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailView />
    </Suspense>
  );
}
