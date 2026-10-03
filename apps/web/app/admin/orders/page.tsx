'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { listOrdersAdminRequest } from '@/lib/admin';
import { formatCents } from '@/lib/format';
import type { OrderStatus } from '@/lib/types/order';
import { useAuthStore } from '@/store/authStore';
import { Button } from '../../components/ui/Button';
import { inputClass } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';
import { PageHeader, PageMessage, Skeleton } from '../../components/ui/Page';
import { OrderStatusPill } from '../../components/ui/StatusPill';

const STATUSES: OrderStatus[] = ['PENDING_PAYMENT', 'PAID', 'SHIPPED', 'DELIVERED', 'CANCELLED'];

function OrdersList() {
  const accessToken = useAuthStore((s) => s.accessToken)!;
  const [status, setStatus] = useState<OrderStatus | ''>('');
  const [needsRefund, setNeedsRefund] = useState(useSearchParams().get('needsRefund') === 'true');

  const filters = { ...(status ? { status } : {}), ...(needsRefund ? { needsRefund: true } : {}) };
  const query = useInfiniteQuery({
    queryKey: ['admin', 'orders', filters],
    queryFn: ({ pageParam }) => listOrdersAdminRequest(accessToken, filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const orders = query.data?.pages.flatMap((p) => p.orders) ?? [];

  return (
    <>
      <PageHeader title="Orders" subtitle="Every order across the marketplace." />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <select
          aria-label="Filter by status"
          value={status}
          disabled={needsRefund}
          onChange={(e) => setStatus(e.target.value as OrderStatus | '')}
          className={`${inputClass(false)} sm:w-auto`}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input type="checkbox" checked={needsRefund} onChange={(e) => setNeedsRefund(e.target.checked)} />
          Only orders that need a refund
        </label>
      </div>

      {needsRefund && (
        <div className="mb-5">
          <Notice tone="info">
            These orders were cancelled after the buyer’s payment succeeded. Refunds are not automatic yet: return the
            money through your payment provider, then note it in the audit trail.
          </Notice>
        </div>
      )}

      {query.isLoading && (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      )}
      {query.isError && <PageMessage title="Couldn’t load orders" body="Try refreshing the page." />}
      {!query.isLoading && !query.isError && orders.length === 0 && (
        <PageMessage title="No orders match" body="Try a different filter." />
      )}
      {orders.length > 0 && (
        <ul className="overflow-hidden rounded-2xl border-2 border-line bg-white">
          {orders.map((order) => (
            <li key={order.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line/10 px-4 py-3 last:border-b-0">
              <div className="min-w-0 text-sm">
                <p className="font-display font-bold">
                  Order {order.id.slice(0, 8)} ·{' '}
                  <Link href={`/auctions/${order.auctionId}`} className="underline underline-offset-4">
                    view auction
                  </Link>
                </p>
                <p className="truncate text-ink/70">
                  {order.buyerEmail} bought from {order.sellerEmail} · {new Date(order.createdAt).toLocaleDateString()}
                </p>
                {order.status === 'CANCELLED' && order.cancelReason && (
                  <p className="text-ink/60">Cancelled: {order.cancelReason === 'PAYMENT_TIMEOUT' ? 'payment timed out' : 'by an admin'}</p>
                )}
              </div>
              <div className="flex items-center gap-3">
                {order.needsRefund && (
                  <span className="rounded-full border-2 border-line bg-pink px-2.5 py-0.5 text-xs font-bold">Needs refund</span>
                )}
                <OrderStatusPill status={order.status} />
                <p className="font-display text-lg font-extrabold">{formatCents(order.amountCents)}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {query.hasNextPage && (
        <div className="mt-5 flex justify-center">
          <Button variant="secondary" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
            {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </>
  );
}

// useSearchParams needs a Suspense boundary for static rendering.
export default function AdminOrdersPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64" />}>
      <OrdersList />
    </Suspense>
  );
}
