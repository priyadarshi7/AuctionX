'use client';

import { IconShoppingBag, IconTag } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/wensity/tabs';
import { listMyOrdersRequest } from '@/lib/orders';
import { formatCents } from '@/lib/format';
import { useRequireAuth } from '@/lib/useRequireAuth';
import { ButtonLink } from '../components/ui/Button';
import { PageHeader, PageLoading, PageMessage, Skeleton } from '../components/ui/Page';
import { OrderStatusPill } from '../components/ui/StatusPill';

type Filter = 'ALL' | 'BUYING' | 'SELLING';

export default function OrdersPage() {
  const auth = useRequireAuth();
  const [filter, setFilter] = useState<Filter>('ALL');

  const ordersQuery = useQuery({
    queryKey: ['orders', 'mine'],
    queryFn: () => listMyOrdersRequest(auth.accessToken!),
    enabled: auth.ready,
  });

  if (!auth.ready) {
    return <PageLoading />;
  }

  const { user } = auth;
  const all = ordersQuery.data?.orders ?? [];
  // An order's two parties see the same row from opposite sides (Section 19
  // doesn't distinguish "buyer view" vs "seller view" structurally) — the
  // role label and filter are the only places that distinction surfaces,
  // purely for the viewer's own orientation.
  const roleOf = (buyerId: string) => (buyerId === user.id ? 'BUYING' : 'SELLING');
  const orders = all.filter((o) => filter === 'ALL' || roleOf(o.buyerId) === filter);
  const toPay = all.filter((o) => o.buyerId === user.id && o.status === 'PENDING_PAYMENT').length;
  const toShip = all.filter((o) => o.sellerId === user.id && o.status === 'PAID').length;
  const toConfirm = all.filter((o) => o.buyerId === user.id && o.status === 'SHIPPED').length;

  const tabs: { id: Filter; label: string }[] = [
    { id: 'ALL', label: 'All' },
    { id: 'BUYING', label: 'Buying' },
    { id: 'SELLING', label: 'Selling' },
  ];

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-10">
      <PageHeader
        title="My orders"
        subtitle={
          toPay > 0
            ? `${toPay} ${toPay === 1 ? 'order is' : 'orders are'} waiting for your payment.`
            : toShip > 0
              ? `${toShip} ${toShip === 1 ? 'order is' : 'orders are'} paid and waiting for you to ship.`
              : toConfirm > 0
                ? `${toConfirm} ${toConfirm === 1 ? 'order has' : 'orders have'} shipped. Confirm delivery when they arrive.`
                : 'Wins and sales show up here.'
        }
      />

      <Tabs variant="segmented" value={filter} onValueChange={(next) => setFilter(next as Filter)} className="mb-6 items-start">
        <TabsList aria-label="Filter orders">
          {tabs.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {ordersQuery.isLoading && (
        <ul className="flex flex-col gap-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <li key={i}>
              <Skeleton className="h-20 w-full" />
            </li>
          ))}
        </ul>
      )}

      {ordersQuery.isError && (
        <PageMessage title="Couldn't load your orders" body="Check your connection and refresh to try again." />
      )}

      {!ordersQuery.isLoading && !ordersQuery.isError && orders.length === 0 && (
        <PageMessage
          title={all.length === 0 ? 'No orders yet' : `No ${filter.toLowerCase()} orders`}
          body="Orders appear here once you win an auction or someone wins one of yours."
          action={all.length === 0 ? <ButtonLink href="/auctions">Browse auctions</ButtonLink> : undefined}
        />
      )}

      <ul className="flex flex-col gap-3">
        {orders.map((order) => {
          const buying = order.buyerId === user.id;
          const needsPayment = buying && order.status === 'PENDING_PAYMENT';
          const needsShipping = !buying && order.status === 'PAID';
          const needsConfirm = buying && order.status === 'SHIPPED';
          return (
            <li key={order.id}>
              <Link
                href={`/orders/${order.id}`}
                className="panel flex flex-wrap items-center justify-between gap-4 p-4 transition-colors hover:border-border-strong"
              >
                <div className="flex items-center gap-4">
                  <span
                    aria-hidden
                    className="flex size-10 items-center justify-center rounded-xl border border-border bg-surface-muted text-muted-foreground"
                  >
                    {buying ? <IconShoppingBag className="size-4.5" stroke={1.5} /> : <IconTag className="size-4.5" stroke={1.5} />}
                  </span>
                  <div>
                    <p className="font-medium">
                      {buying ? 'You won an auction' : 'You sold an item'}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Order {order.id.slice(0, 8)} &middot; {new Date(order.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <OrderStatusPill status={order.status} />
                  <p className="figures text-xl">{formatCents(order.amountCents)}</p>
                  {needsPayment && (
                    <span className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-background">Pay now</span>
                  )}
                  {needsShipping && (
                    <span className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-background">Ship now</span>
                  )}
                  {needsConfirm && (
                    <span className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-background">Confirm delivery</span>
                  )}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
