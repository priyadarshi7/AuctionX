'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { listMyOrdersRequest } from '@/lib/orders';
import { formatCents } from '@/lib/format';
import { useAuthStore } from '@/store/authStore';

const STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: 'Awaiting payment',
  PAID: 'Paid',
  CANCELLED: 'Cancelled',
};

export default function OrdersPage() {
  const router = useRouter();
  const status = useAuthStore((state) => state.status);
  const user = useAuthStore((state) => state.user);
  const accessToken = useAuthStore((state) => state.accessToken);

  useEffect(() => {
    if (status === 'anonymous') {
      router.replace('/login');
    }
  }, [status, router]);

  const ordersQuery = useQuery({
    queryKey: ['orders', 'mine'],
    queryFn: () => listMyOrdersRequest(accessToken!),
    enabled: status === 'authenticated' && !!accessToken,
  });

  if (status !== 'authenticated' || !user || !accessToken) {
    return (
      <main className="flex-1 p-6">
        <p className="text-gray-500">Loading…</p>
      </main>
    );
  }

  const orders = ordersQuery.data?.orders ?? [];

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 p-6">
      <h1 className="mb-6 text-2xl font-semibold">My orders</h1>

      {ordersQuery.isLoading && <p className="text-gray-500">Loading…</p>}
      {ordersQuery.isError && <p className="text-red-600">Failed to load your orders.</p>}
      {!ordersQuery.isLoading && !ordersQuery.isError && orders.length === 0 && (
        <p className="text-gray-500">No orders yet — orders appear here once you win an auction.</p>
      )}

      <ul className="flex flex-col gap-3">
        {orders.map((order) => {
          // An order's two parties see the same row from opposite sides
          // (Section 19 doesn't distinguish "buyer view" vs "seller view"
          // structurally) — this label is the only place that distinction
          // is surfaced, purely for the viewer's own orientation.
          const role = order.buyerId === user.id ? 'Buying' : 'Selling';
          return (
            <li key={order.id}>
              <Link
                href={`/orders/${order.id}`}
                className="flex items-center justify-between rounded border border-gray-200 px-4 py-3 hover:bg-gray-50"
              >
                <div>
                  <p className="text-sm text-gray-500">{role}</p>
                  <p className="font-medium">{STATUS_LABEL[order.status] ?? order.status}</p>
                </div>
                <p className="font-semibold">{formatCents(order.amountCents)}</p>
              </Link>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
