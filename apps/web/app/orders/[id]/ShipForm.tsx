'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/apiClient';
import { shipOrderRequest } from '@/lib/orders';
import type { ShippingAddress } from '@/lib/types/order';
import { Button } from '../../components/ui/Button';
import { Notice } from '../../components/ui/Notice';
import { AddressSummary } from './AddressForm';

// The seller's whole job here: see where to send it, send it, say so. The
// carrier and tracking number are assigned by the platform's shipping provider
// (ADR-0045), so there is nothing to type in.
export function ShipForm({
  orderId,
  accessToken,
  address,
}: {
  orderId: string;
  accessToken: string;
  address: ShippingAddress | null;
}) {
  const queryClient = useQueryClient();
  const ship = useMutation({
    mutationFn: () => shipOrderRequest(accessToken, orderId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['orders'] }),
  });
  const error = ship.error instanceof ApiError ? ship.error.message : ship.error ? 'Something went wrong. Please try again.' : null;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink/70">The buyer has paid. Send the item to this address, then mark it as shipped.</p>
      {address ? (
        <div className="rounded-xl border-2 border-line bg-cream-2 p-4">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink/60">Ship to</p>
          <AddressSummary address={address} />
        </div>
      ) : (
        <Notice tone="error">The buyer has not given a delivery address, so this cannot ship yet.</Notice>
      )}
      <Button onClick={() => ship.mutate()} disabled={ship.isPending || !address} className="w-full">
        {ship.isPending ? 'Saving…' : 'Mark as shipped'}
      </Button>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
