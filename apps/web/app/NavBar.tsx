'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { logoutRequest } from '@/lib/auth';
import { useAuthStore } from '@/store/authStore';
import { NotificationBell } from './NotificationBell';

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const active = pathname === href || (href !== '/' && pathname.startsWith(href));

  return (
    <Link
      href={href}
      className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
        active ? 'bg-cyan text-ink' : 'text-ink/70 hover:bg-cream-2 hover:text-ink'
      }`}
    >
      {children}
    </Link>
  );
}

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
    <header className="sticky top-0 z-20 border-b-2 border-line bg-cream/95 px-4 py-3 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-2 font-display text-xl font-extrabold tracking-tight">
          <span className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-line bg-yellow text-sm">
            {'\u{1FA99}'}
          </span>
          AuctionX
        </Link>

        <nav className="hidden items-center gap-1 rounded-full border-2 border-line bg-white px-1.5 py-1.5 sm:flex">
          <NavLink href="/auctions">Browse</NavLink>
          {status === 'authenticated' && (
            <>
              <NavLink href="/auctions/new">Sell</NavLink>
              <NavLink href="/my-auctions">My auctions</NavLink>
              <NavLink href="/orders">Orders</NavLink>
            </>
          )}
        </nav>

        <div className="flex items-center gap-3">
          {status === 'checking' && <span className="text-sm text-ink/50">Checking session…</span>}
          {status === 'authenticated' && user && (
            <>
              <NotificationBell />
              <Link
                href="/account"
                title="Account"
                className="hidden items-center justify-center rounded-full border-2 border-line bg-pink h-8 w-8 text-xs font-bold hover:brightness-95 sm:flex"
              >
                {user.name.charAt(0).toUpperCase()}
              </Link>
              <button
                type="button"
                onClick={handleLogout}
                className="rounded-full border-2 border-line px-3 py-1.5 text-sm font-medium hover:bg-cream-2"
              >
                Log out
              </button>
            </>
          )}
          {status === 'anonymous' && (
            <>
              <Link href="/login" className="rounded-full px-3 py-1.5 text-sm font-medium hover:bg-cream-2">
                Log in
              </Link>
              <Link
                href="/register"
                className="rounded-full border-2 border-line bg-yellow px-3 py-1.5 text-sm font-semibold shadow-hard-sm transition-transform hover:-translate-y-0.5"
              >
                Register
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
