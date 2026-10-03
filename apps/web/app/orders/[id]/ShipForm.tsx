'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ApiError } from '@/lib/apiClient';
import { shipOrderRequest } from '@/lib/orders';
import { Button } from '../../components/ui/Button';
import { Field, inputClass } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';

// Mirrors services/api/src/modules/orders/schema.ts's shipOrderSchema; the
// server re-validates (nothing here is trusted), this only saves a round
// trip for an obviously blank field.
const shipFormSchema = z.object({
  carrier: z.string().trim().min(1, 'Enter the carrier').max(100),
  trackingNumber: z.string().trim().min(1, 'Enter the tracking number').max(100),
});
type ShipFormValues = z.infer<typeof shipFormSchema>;

export function ShipForm({ orderId, accessToken }: { orderId: string; accessToken: string }) {
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ShipFormValues>({ resolver: zodResolver(shipFormSchema) });

  const ship = useMutation({
    mutationFn: (values: ShipFormValues) => shipOrderRequest(accessToken, orderId, values),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['orders'] }),
  });
  const error = ship.error instanceof ApiError ? ship.error.message : ship.error ? 'Something went wrong. Please try again.' : null;

  return (
    <form onSubmit={handleSubmit((values) => ship.mutate(values))} noValidate className="flex flex-col gap-3">
      <p className="text-sm text-ink/70">The buyer has paid. Ship the item, then enter the details so they can track it.</p>
      <Field label="Carrier" htmlFor="carrier" error={errors.carrier?.message}>
        <input
          id="carrier"
          type="text"
          autoComplete="off"
          placeholder="e.g. DHL, FedEx, India Post"
          aria-invalid={errors.carrier ? true : undefined}
          {...register('carrier')}
          className={inputClass(!!errors.carrier)}
        />
      </Field>
      <Field label="Tracking number" htmlFor="trackingNumber" error={errors.trackingNumber?.message}>
        <input
          id="trackingNumber"
          type="text"
          autoComplete="off"
          aria-invalid={errors.trackingNumber ? true : undefined}
          {...register('trackingNumber')}
          className={inputClass(!!errors.trackingNumber)}
        />
      </Field>
      <Button type="submit" disabled={ship.isPending} className="w-full">
        {ship.isPending ? 'Saving…' : 'Mark as shipped'}
      </Button>
      {error && <Notice tone="error">{error}</Notice>}
    </form>
  );
}
