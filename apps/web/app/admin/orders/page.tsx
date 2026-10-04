'use client';

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { listOrdersAdminRequest, refundOrderRequest } from '@/lib/admin';
import { ApiError } from '@/lib/apiClient';
import { formatCents } from '@/lib/format';
import type { OrderStatus } from '@/lib/types/order';
import { useAuthStore } from '@/store/authStore';
import { Button } from '../../components/ui/Button';
import { inputClass } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';
import { PageHeader, PageMessage, Skeleton } from '../../components/ui/Page';
import { OrderStatusPill } from '../../components/ui/StatusPill';

const STATUSES: OrderStatus[] = ['PENDING_PAYMENT', 'PAID', 'SHIPPED', 'DELIVERED', 'CANCELLED'];

function RefundButton({ orderId, accessToken }: { orderId: string; accessToken: string }) {
  const queryClient = useQueryClient();
  const refund = useMutation({
    mutationFn: () => refundOrderRequest(accessToken, orderId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });
  const error = refund.error instanceof ApiError ? refund.error.message : refund.error ? 'Refund failed.' : null;
  return (
    <span className="flex flex-col items-end gap-1">
      <Button size="sm" variant="danger" disabled={refund.isPending} onClick={() => refund.mutate()}>
        {refund.isPending ? 'Refunding…' : 'Refund'}
      </Button>
      {error && <span className="text-xs font-medium">{error}</span>}
    </span>
  );
}

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
            These orders were cancelled after the buyer’s payment succeeded. The system tries to refund them
            automatically; any that appear here are ones where that attempt failed. Use Refund to retry.
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
                  <>
                    <span className="rounded-full border-2 border-line bg-pink px-2.5 py-0.5 text-xs font-bold">Needs refund</span>
                    <RefundButton orderId={order.id} accessToken={accessToken} />
                  </>
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
