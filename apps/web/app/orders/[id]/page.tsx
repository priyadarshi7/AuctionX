'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { ApiError } from '@/lib/apiClient';
import { getOrderRequest, payOrderRequest } from '@/lib/orders';
import { formatCents } from '@/lib/format';
import { useAuthStore } from '@/store/authStore';
import type { Order } from '@/lib/types/order';

const STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: 'Awaiting payment',
  PAID: 'Paid',
  CANCELLED: 'Cancelled',
};

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const orderId = params.id;
  const router = useRouter();
  const queryClient = useQueryClient();
  const status = useAuthStore((state) => state.status);
  const user = useAuthStore((state) => state.user);
  const accessToken = useAuthStore((state) => state.accessToken);

  useEffect(() => {
    if (status === 'anonymous') {
      router.replace('/login');
    }
  }, [status, router]);

  // Generated once per page visit, not per click — a double-click while the
  // request is in flight (the button is disabled during that window, but a
  // network retry could still resend it) must replay the SAME attempt, not
  // start a second one (Section 11). A fresh visit to this page (or a
  // manual retry after a FAILED payment) is a legitimately new attempt, so
  // this regenerates on remount, not sessionStorage-persisted.
  const idempotencyKeyRef = useRef(crypto.randomUUID());

  const orderQuery = useQuery({
    queryKey: ['orders', orderId],
    queryFn: () => getOrderRequest(accessToken!, orderId),
    enabled: status === 'authenticated' && !!accessToken,
    // The webhook that flips PENDING_PAYMENT -> PAID arrives ~300ms after
    // MockPaymentProvider.createPaymentIntent (ADR-0025) — polling while
    // still pending picks that up without the buyer needing to refresh.
    // Stops polling the instant it reaches a terminal state.
    refetchInterval: (query) => (query.state.data?.order.status === 'PENDING_PAYMENT' ? 1000 : false),
  });

  const pay = useMutation({
    mutationFn: () => payOrderRequest(accessToken!, orderId, idempotencyKeyRef.current),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['orders', orderId] });
    },
  });

  if (status !== 'authenticated' || !user || !accessToken) {
    return (
      <main className="flex-1 p-6">
        <p className="text-gray-500">Loading…</p>
      </main>
    );
  }

  if (orderQuery.isLoading) {
    return (
      <main className="flex-1 p-6">
        <p className="text-gray-500">Loading…</p>
      </main>
    );
  }

  if (orderQuery.isError || !orderQuery.data) {
    const message =
      orderQuery.error instanceof ApiError && orderQuery.error.status === 403
        ? "You don't have access to this order."
        : 'Order not found.';
    return (
      <main className="flex-1 p-6">
        <p className="text-red-600">{message}</p>
      </main>
    );
  }

  const order: Order = orderQuery.data.order;
  const isBuyer = order.buyerId === user.id;
  const payError = pay.error instanceof ApiError ? pay.error.message : pay.error ? 'Something went wrong.' : null;

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Order</h1>
        <p className="text-sm text-gray-500">{isBuyer ? "You're the buyer" : "You're the seller"} on this order.</p>
      </div>

      <div className="flex items-baseline justify-between rounded border border-gray-200 p-4">
        <div>
          <p className="text-sm text-gray-500">Amount</p>
          <p className="text-2xl font-bold">{formatCents(order.amountCents)}</p>
        </div>
        <div className="text-right">
          <p className="text-sm text-gray-500">Status</p>
          <p className="font-medium">{STATUS_LABEL[order.status] ?? order.status}</p>
        </div>
      </div>

      {isBuyer && order.status === 'PENDING_PAYMENT' && (
        <div>
          <button
            type="button"
            onClick={() => pay.mutate()}
            disabled={pay.isPending || pay.isSuccess}
            className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {pay.isPending || pay.isSuccess ? 'Processing…' : 'Pay now'}
          </button>
          {payError && <p className="mt-2 text-sm text-red-600">{payError}</p>}
        </div>
      )}

      {order.status === 'PAID' && <p className="text-sm text-green-700">This order has been paid in full.</p>}

      {!isBuyer && order.status === 'PENDING_PAYMENT' && (
        <p className="text-sm text-gray-500">Waiting for the buyer to complete payment.</p>
      )}
    </main>
  );
}
