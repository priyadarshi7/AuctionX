'use client';

import { useAuthStore } from '@/store/authStore';

// Deliberately minimal — this page exists right now to prove the whole
// pipeline (silent refresh, Zustand auth state, CORS+credentials against
// the real API) works end to end. Auction browsing/creation are their own
// upcoming tasks (WEB-001+), not squeezed into this foundation task.
export default function Home() {
  const user = useAuthStore((state) => state.user);
  const status = useAuthStore((state) => state.status);

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <h1 className="text-3xl font-bold">AuctionX</h1>
      {status === 'checking' && <p className="text-gray-500">Checking session…</p>}
      {status === 'authenticated' && user && (
        <p>
          Logged in as <span className="font-medium">{user.email}</span> ({user.role})
        </p>
      )}
      {status === 'anonymous' && <p className="text-gray-500">Not logged in.</p>}
    </main>
  );
}
