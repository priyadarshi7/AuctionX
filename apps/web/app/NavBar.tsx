'use client';

import { IconLogout, IconMenu2 } from '@tabler/icons-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/wensity/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/wensity/dropdown-menu';
import { logoutRequest } from '@/lib/auth';
import { useAuthStore } from '@/store/authStore';
import { CatalogueSearch } from './components/CatalogueSearch';
import { ThemeToggle } from './components/ThemeToggle';
import { ButtonLink } from './components/ui/Button';
import { NotificationBell } from './NotificationBell';

function NavLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`flex h-full items-center whitespace-nowrap border-b-2 pt-0.5 text-[11px] font-medium uppercase tracking-[0.16em] transition-colors ${
        active
          ? 'border-accent text-foreground'
          : 'border-transparent text-muted-foreground hover:border-border-strong hover:text-foreground'
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
  const pathname = usePathname();
  const signedIn = status === 'authenticated' && !!user;

  const handleLogout = async () => {
    // Best-effort: even if the network call fails, the user's intent is to
    // be logged out locally — clearSession() always runs. logoutUser on
    // the backend is itself idempotent (AUTH-003), so a retry-safe
    // best-effort call here is consistent with that, not a shortcut.
    await logoutRequest().catch(() => undefined);
    clearSession();
  };

  // One list drives both the desktop links and the mobile menu.
  const links = [
    { href: '/auctions', label: 'Catalogue' },
    ...(signedIn
      ? [
          { href: '/auctions/new', label: 'Sell' },
          { href: '/my-auctions', label: 'My auctions' },
          { href: '/orders', label: 'Orders' },
          ...(user.role === 'ADMIN' ? [{ href: '/admin', label: 'Admin' }] : []),
        ]
      : []),
  ];

  // The most specific match wins, so /auctions/new lights up Sell, not Browse.
  const activeHref = links
    .map((link) => link.href)
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.length - a.length)[0];

  return (
    <header className="sticky top-0 z-40 bg-background/90 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:gap-8 sm:px-6">
        <Link href="/" className="font-serif text-2xl font-medium leading-none tracking-tight">
          Auction<span className="italic text-accent">X</span>
        </Link>

        <nav aria-label="Main" className="hidden h-full items-stretch gap-6 md:flex">
          {links.map((link) => (
            <NavLink key={link.href} href={link.href} active={link.href === activeHref}>
              {link.label}
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-1">
          <CatalogueSearch />
          <ThemeToggle />

          {status === 'checking' && (
            <span aria-label="Checking session" className="ml-1 size-8 animate-pulse rounded-full bg-muted" />
          )}

          {signedIn && (
            <>
              <NotificationBell />
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label="Account menu"
                  className="ml-1 flex size-8 items-center justify-center rounded-full border border-border-strong bg-surface text-xs font-semibold outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primitive-ring"
                >
                  {user.name.charAt(0).toUpperCase()}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={8} className="min-w-52">
                  <div className="px-2.5 py-2">
                    <p className="truncate text-sm font-medium">{user.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                  </div>
                  <DropdownMenuSeparator />
                  <div className="md:hidden">
                    {links.map((link) => (
                      <DropdownMenuItem key={link.href} render={<Link href={link.href} />}>
                        {link.label}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                  </div>
                  <DropdownMenuItem render={<Link href="/account" />}>Account</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void handleLogout()}>
                    <IconLogout aria-hidden className="size-4" stroke={1.6} />
                    Log out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}

          {status === 'anonymous' && (
            <div className="ml-1 flex items-center gap-1">
              <div className="hidden sm:block">
                <ButtonLink href="/login" variant="ghost" size="sm">
                  Log in
                </ButtonLink>
              </div>
              <ButtonLink href="/register" size="sm">
                Sign up
              </ButtonLink>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Menu" className="md:hidden">
                    <IconMenu2 className="size-4.5" stroke={1.6} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={8} className="min-w-44">
                  {links.map((link) => (
                    <DropdownMenuItem key={link.href} render={<Link href={link.href} />}>
                      {link.label}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem render={<Link href="/login" />}>Log in</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      </div>
      <div aria-hidden className="rule-double" />
    </header>
  );
}
