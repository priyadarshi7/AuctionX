'use client';

import Link from 'next/link';
import { logoutRequest } from '@/lib/auth';
import { useAuthStore } from '@/store/authStore';

export function NavBar() {
  const user = useAuthStore((state) => state.user);
  const status = useAuthStore((state) => state.status);
  const clearSession = useAuthStore((state) => state.clearSession);

  const handleLogout = async () => {
    // Best-effort: even if the network call fails, the user's intent is to
    // be logged out locally — clearSession() always runs. logoutUser on
    // the backend is itself idempotent (AUTH-003), so a retry-safe
    // best-effort call here is consistent with that, not a shortcut.
    await logoutRequest().catch(() => undefined);
    clearSession();
  };

  return (
    <header className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
      <Link href="/" className="text-lg font-semibold">
        AuctionX
      </Link>
      <nav className="flex items-center gap-4 text-sm">
        <Link href="/auctions" className="hover:text-gray-600">
          Browse
        </Link>
        {status === 'checking' && <span className="text-gray-400">Checking session…</span>}
        {status === 'authenticated' && user && (
          <>
            <Link href="/auctions/new" className="hover:text-gray-600">
              Sell an item
            </Link>
            <Link href="/my-auctions" className="hover:text-gray-600">
              My auctions
            </Link>
            <Link href="/orders" className="hover:text-gray-600">
              My orders
            </Link>
            <span className="text-gray-700">
              Signed in as <span className="font-medium">{user.name}</span>
            </span>
            <button type="button" onClick={handleLogout} className="underline hover:text-gray-600">
              Log out
            </button>
          </>
        )}
        {status === 'anonymous' && (
          <>
            <Link href="/login" className="underline hover:text-gray-600">
              Log in
            </Link>
            <Link href="/register" className="underline hover:text-gray-600">
              Register
            </Link>
          </>
        )}
      </nav>
    </header>
  );
}
