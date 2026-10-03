'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useRequireAuth } from '@/lib/useRequireAuth';
import { ButtonLink } from '../components/ui/Button';
import { PageLoading, PageMessage } from '../components/ui/Page';

const TABS = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/auctions', label: 'Auctions' },
  { href: '/admin/orders', label: 'Orders' },
  { href: '/admin/audit-log', label: 'Audit log' },
];

// This is a UX gate, not a security one: it stops non-admins seeing a broken
// page. Every /api/v1/admin endpoint independently enforces ADMIN on the
// server (401/403), so bypassing this component gets a visitor nothing.
export default function AdminLayout({ children }: { children: ReactNode }) {
  const auth = useRequireAuth();
  const pathname = usePathname();

  if (!auth.ready) {
    return <PageLoading />;
  }

  if (auth.user.role !== 'ADMIN') {
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-16">
        <PageMessage
          title="Admins only"
          body="You don’t have access to this area."
          action={<ButtonLink href="/">Back home</ButtonLink>}
        />
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
      <nav aria-label="Admin sections" className="mb-8 flex flex-wrap gap-2">
        {TABS.map((tab) => {
          const active = tab.href === '/admin' ? pathname === '/admin' : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              className={`rounded-full border-2 border-line px-4 py-1.5 text-sm font-semibold transition-colors ${
                active ? 'bg-yellow shadow-hard-sm' : 'bg-white hover:bg-cream-2'
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </main>
  );
}
