'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { listAuditLogRequest, getStatsRequest } from '@/lib/admin';
import { useAuthStore } from '@/store/authStore';
import { formatCents } from '@/lib/format';
import { Notice } from '../components/ui/Notice';
import { PageHeader, Skeleton } from '../components/ui/Page';
import { AuditList } from './AuditList';

function StatCard({ label, value, hint, href }: { label: string; value: string | number; hint?: string; href?: string }) {
  const body = (
    <div className="h-full rounded-2xl border-2 border-line bg-white p-5 shadow-hard-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">{label}</p>
      <p className="mt-1 font-display text-3xl font-extrabold">{value}</p>
      {hint && <p className="mt-1 text-sm text-ink/60">{hint}</p>}
    </div>
  );
  return href ? (
    <Link href={href} className="block transition-transform hover:-translate-y-0.5">
      {body}
    </Link>
  ) : (
    body
  );
}

// Module-level so the clock read is not an impure call during render.
function hoursSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
}

export default function AdminDashboardPage() {
  const accessToken = useAuthStore((s) => s.accessToken)!;

  const stats = useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: () => getStatsRequest(accessToken),
    refetchInterval: 30_000,
  });
  const recent = useQuery({
    queryKey: ['admin', 'audit-log', 'recent'],
    queryFn: () => listAuditLogRequest(accessToken, undefined, 5),
  });

  const s = stats.data?.stats;
  const live = s?.auctions.ACTIVE ?? 0;
  const pendingOrders = s?.orders.PENDING_PAYMENT ?? 0;
  const awaitingReview = s?.auctions.PENDING_REVIEW ?? 0;
  const oldestHours = s?.oldestPendingReviewAt ? hoursSince(s.oldestPendingReviewAt) : 0;
  const queueIsStale = oldestHours >= 24;
  const oldestLabel = oldestHours >= 24 ? `${Math.floor(oldestHours / 24)}d` : oldestHours >= 1 ? `${oldestHours}h` : 'under an hour';

  return (
    <>
      <PageHeader title="Dashboard" subtitle="A live snapshot of the marketplace." />

      {stats.isError && <Notice tone="error">Couldn’t load the stats. Try refreshing.</Notice>}

      {awaitingReview > 0 && (
        <div className="mb-6">
          <Notice tone={queueIsStale ? 'error' : 'info'}>
            <strong>{awaitingReview}</strong> {awaitingReview === 1 ? 'listing is' : 'listings are'} waiting for your
            review. The oldest has waited {oldestLabel}.{queueIsStale && ' Sellers are waiting a long time.'}{' '}
            <Link href="/admin/auctions?status=PENDING_REVIEW" className="font-semibold underline underline-offset-4">
              Open the review queue
            </Link>
          </Notice>
        </div>
      )}

      {s && s.needsRefund > 0 && (
        <div className="mb-6">
          <Notice tone="error">
            <strong>{s.needsRefund}</strong> {s.needsRefund === 1 ? 'order was' : 'orders were'} cancelled after the
            buyer’s payment succeeded. The money has not been returned.{' '}
            <Link href="/admin/orders?needsRefund=true" className="font-semibold underline underline-offset-4">
              Review them
            </Link>
          </Notice>
        </div>
      )}

      {stats.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : (
        s && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Awaiting review"
              value={awaitingReview}
              hint="New listings to approve"
              href="/admin/auctions?status=PENDING_REVIEW"
            />
            <StatCard label="Live auctions" value={live} hint={`${s.auctions.PAUSED ?? 0} paused`} href="/admin/auctions" />
            <StatCard label="Bids (24h)" value={s.bids.last24Hours} hint={`${s.bids.total} all time`} />
            <StatCard label="Users" value={s.users.total} hint={`${s.users.newLast7Days} new this week`} href="/admin/users" />
            <StatCard
              label="Restricted users"
              value={s.users.restricted}
              hint="Suspended or banned"
              href="/admin/users"
            />
            <StatCard label="Revenue" value={formatCents(s.revenueCents)} hint="Paid, shipped and delivered orders" />
            <StatCard label="Awaiting payment" value={pendingOrders} href="/admin/orders" />
            <StatCard label="Shipped" value={s.orders.SHIPPED ?? 0} hint={`${s.orders.DELIVERED ?? 0} delivered`} />
            <StatCard label="Ended auctions" value={s.auctions.ENDED ?? 0} hint={`${s.auctions.CANCELLED ?? 0} cancelled`} />
          </div>
        )
      )}

      <section aria-labelledby="recent-heading" className="mt-10">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 id="recent-heading" className="font-display text-xl font-extrabold">
            Recent admin activity
          </h2>
          <Link href="/admin/audit-log" className="text-sm font-semibold underline underline-offset-4">
            View all
          </Link>
        </div>
        {recent.isLoading ? <Skeleton className="h-24" /> : <AuditList entries={recent.data?.entries ?? []} />}
      </section>
    </>
  );
}
