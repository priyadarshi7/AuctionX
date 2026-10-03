'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useRef } from 'react';
import { ApiError } from '@/lib/apiClient';
import { confirmDeliveryRequest, getOrderRequest, payOrderRequest } from '@/lib/orders';
import { formatCents } from '@/lib/format';
import { useRequireAuth } from '@/lib/useRequireAuth';
import type { Order } from '@/lib/types/order';
import { Button, ButtonLink } from '../../components/ui/Button';
import { Notice } from '../../components/ui/Notice';
import { PageLoading, PageMessage } from '../../components/ui/Page';
import { OrderStatusPill } from '../../components/ui/StatusPill';
import { ShipForm } from './ShipForm';

type StepState = 'done' | 'current' | 'todo';

function Timeline({ order }: { order: Order }) {
  const cancelled = order.status === 'CANCELLED';
  const paid = order.status === 'PAID' || order.status === 'SHIPPED' || order.status === 'DELIVERED';
  const shipped = order.status === 'SHIPPED' || order.status === 'DELIVERED';
  const delivered = order.status === 'DELIVERED';

  // The first step that isn't done yet is the "current" one; a cancelled
  // order stops after the payment step and shows nothing further to do.
  const cancelDetail =
    order.cancelReason === 'PAYMENT_TIMEOUT'
      ? 'Cancelled because payment was not received in time.'
      : 'This order was cancelled.';
  const steps: { label: string; detail: string; state: StepState }[] = [
    { label: 'Auction won', detail: new Date(order.createdAt).toLocaleString(), state: 'done' },
    {
      label: cancelled ? 'Order cancelled' : 'Payment',
      detail: cancelled
        ? cancelDetail
        : paid
          ? 'Received in full.'
          : order.paymentDueAt
            ? `Waiting for the buyer to pay. Due ${new Date(order.paymentDueAt).toLocaleString()}.`
            : 'Waiting for the buyer to pay.',
      state: paid || cancelled ? 'done' : 'current',
    },
    ...(cancelled
      ? []
      : ([
          {
            label: 'Shipped',
            detail: shipped
              ? `${order.carrier ?? 'Carrier'} · tracking ${order.trackingNumber ?? 'n/a'}${order.shippedAt ? ` · ${new Date(order.shippedAt).toLocaleDateString()}` : ''}`
              : 'The seller ships once payment is received.',
            state: shipped ? 'done' : paid ? 'current' : 'todo',
          },
          {
            label: 'Delivered',
            detail: delivered
              ? `Confirmed by the buyer${order.deliveredAt ? ` on ${new Date(order.deliveredAt).toLocaleDateString()}` : ''}.`
              : 'The buyer confirms when it arrives.',
            state: delivered ? 'done' : shipped ? 'current' : 'todo',
          },
        ] as { label: string; detail: string; state: StepState }[])),
  ];

  return (
    <ol aria-label="Order progress" className="flex flex-col gap-4">
      {steps.map((step, i) => (
        <li key={step.label} className="flex items-start gap-4">
          <span
            aria-hidden
            className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-line text-sm font-extrabold ${
              step.state === 'done' ? 'bg-green' : step.state === 'current' ? 'bg-yellow' : 'bg-white text-ink/50'
            }`}
          >
            {step.state === 'done' ? '✓' : i + 1}
          </span>
          <div>
            <p className={`font-display font-bold ${step.state === 'todo' ? 'text-ink/60' : ''}`}>
              {step.label}
              <span className="sr-only"> ({step.state === 'done' ? 'done' : step.state === 'current' ? 'in progress' : 'not started'})</span>
            </p>
            <p className="text-sm text-ink/70">{step.detail}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const orderId = params.id;
  const queryClient = useQueryClient();
  const auth = useRequireAuth();

  // Generated once per page visit, not per click — a double-click while the
  // request is in flight (the button is disabled during that window, but a
  // network retry could still resend it) must replay the SAME attempt, not
  // start a second one (Section 11). A fresh visit to this page (or a
  // manual retry after a FAILED payment) is a legitimately new attempt, so
  // this regenerates on remount, not sessionStorage-persisted.
  const idempotencyKeyRef = useRef(crypto.randomUUID());

  const orderQuery = useQuery({
    queryKey: ['orders', orderId],
    queryFn: () => getOrderRequest(auth.accessToken!, orderId),
    enabled: auth.ready,
    // The webhook that flips PENDING_PAYMENT -> PAID arrives ~300ms after
    // MockPaymentProvider.createPaymentIntent (ADR-0025) — polling while
    // still pending picks that up without the buyer needing to refresh.
    // Stops polling the instant it reaches a terminal state.
    refetchInterval: (query) => (query.state.data?.order.status === 'PENDING_PAYMENT' ? 1000 : false),
  });

  const confirmDelivery = useMutation({
    mutationFn: () => confirmDeliveryRequest(auth.accessToken!, orderId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
  });

  const pay = useMutation({
    mutationFn: () => payOrderRequest(auth.accessToken!, orderId, idempotencyKeyRef.current),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['orders', orderId] });
    },
  });

  if (!auth.ready || orderQuery.isLoading) {
    return <PageLoading />;
  }

  if (orderQuery.isError || !orderQuery.data) {
    const forbidden = orderQuery.error instanceof ApiError && orderQuery.error.status === 403;
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-16">
        <PageMessage
          title={forbidden ? 'This order isn’t yours' : 'We couldn’t find that order'}
          body={forbidden ? 'Only the buyer and seller can view an order.' : 'It may have been removed, or the link is wrong.'}
          action={<ButtonLink href="/orders">Back to orders</ButtonLink>}
        />
      </main>
    );
  }

  const order: Order = orderQuery.data.order;
  const isBuyer = order.buyerId === auth.user.id;
  const paying = pay.isPending || pay.isSuccess;
  const confirmError =
    confirmDelivery.error instanceof ApiError ? confirmDelivery.error.message : confirmDelivery.error ? 'Something went wrong.' : null;
  const payError = pay.error instanceof ApiError ? pay.error.message : pay.error ? 'Something went wrong.' : null;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
      <nav aria-label="Breadcrumb" className="mb-6 text-sm text-ink/70">
        <Link href="/orders" className="font-semibold underline underline-offset-4">
          Orders
        </Link>{' '}
        / Order {order.id.slice(0, 8)}
      </nav>

      <div className="grid gap-6 sm:grid-cols-[1fr_1.2fr]">
        <div className="rounded-2xl border-2 border-line bg-white p-6 shadow-hard">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Amount</p>
          <p className="font-display text-4xl font-extrabold">{formatCents(order.amountCents)}</p>
          <div className="mt-3 flex items-center gap-2">
            <OrderStatusPill status={order.status} />
            <span className="text-sm text-ink/70">{isBuyer ? 'You are the buyer' : 'You are the seller'}</span>
          </div>

          <div className="mt-6 flex flex-col gap-3">
            {isBuyer && order.status === 'PENDING_PAYMENT' && (
              <>
                <Button onClick={() => pay.mutate()} disabled={paying} className="w-full">
                  {paying ? 'Processing…' : `Pay ${formatCents(order.amountCents)}`}
                </Button>
                {payError && <Notice tone="error">{payError}</Notice>}
                {paying && !payError && <Notice tone="info">Confirming your payment. This usually takes a moment.</Notice>}
              </>
            )}
            {!isBuyer && order.status === 'PENDING_PAYMENT' && (
              <Notice tone="info">Waiting for the buyer to complete payment.</Notice>
            )}
            {isBuyer && order.status === 'PENDING_PAYMENT' && order.paymentDueAt && (
              <p className="text-xs text-ink/60">
                Pay by {new Date(order.paymentDueAt).toLocaleString()} or the order is cancelled.
              </p>
            )}
            {order.status === 'PAID' && isBuyer && (
              <Notice tone="success">Payment received. The seller will ship your item soon.</Notice>
            )}
            {order.status === 'PAID' && !isBuyer && auth.accessToken && (
              <ShipForm orderId={order.id} accessToken={auth.accessToken} />
            )}
            {order.status === 'SHIPPED' && isBuyer && (
              <>
                <Notice tone="info">
                  Shipped via {order.carrier} (tracking {order.trackingNumber}). Once it arrives, confirm below.
                </Notice>
                <Button onClick={() => confirmDelivery.mutate()} disabled={confirmDelivery.isPending} className="w-full">
                  {confirmDelivery.isPending ? 'Confirming…' : 'I received it'}
                </Button>
                {confirmError && <Notice tone="error">{confirmError}</Notice>}
              </>
            )}
            {order.status === 'SHIPPED' && !isBuyer && (
              <Notice tone="info">Shipped. Waiting for the buyer to confirm delivery.</Notice>
            )}
            {order.status === 'DELIVERED' && <Notice tone="success">Delivered. This sale is complete.</Notice>}
            {order.status === 'CANCELLED' && (
              <Notice tone="info">
                {order.cancelReason === 'PAYMENT_TIMEOUT'
                  ? 'This order was cancelled because payment was not received in time.'
                  : 'This order was cancelled.'}
              </Notice>
            )}
            <ButtonLink href={`/auctions/${order.auctionId}`} variant="secondary" size="sm">
              View the auction
            </ButtonLink>
          </div>
        </div>

        <div className="rounded-2xl border-2 border-line bg-cream-2 p-6">
          <h2 className="mb-5 font-display text-xl font-extrabold">Progress</h2>
          <Timeline order={order} />
        </div>
      </div>
    </main>
  );
}
