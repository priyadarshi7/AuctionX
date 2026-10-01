import { Suspense } from 'react';
import { ResetPasswordView } from './ResetPasswordView';

// useSearchParams (inside ResetPasswordView, reading ?token=) opts the
// subtree out of static prerendering — same reasoning/pattern as
// app/auctions/page.tsx.
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordView />
    </Suspense>
  );
}
