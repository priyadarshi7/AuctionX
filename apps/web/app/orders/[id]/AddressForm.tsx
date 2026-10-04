'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ApiError } from '@/lib/apiClient';
import { saveShippingAddressRequest } from '@/lib/orders';
import type { ShippingAddress } from '@/lib/types/order';
import { Button } from '../../components/ui/Button';
import { Field, inputClass } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';

// Mirrors services/api/src/modules/orders/address.ts. The server validates
// again (nothing here is trusted); this only saves a round trip.
const addressFormSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter the recipient’s full name').max(100),
  line1: z.string().trim().min(3, 'Enter the street address').max(120),
  line2: z.string().trim().max(120).optional(),
  city: z.string().trim().min(1, 'Enter the city').max(80),
  region: z.string().trim().min(1, 'Enter the state or region').max(80),
  postalCode: z
    .string()
    .trim()
    .min(3, 'Enter the postal code')
    .max(12)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 -]*$/, 'Enter a valid postal code'),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'Use the 2-letter country code, for example IN or US'),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9][0-9 ()-]{6,18}$/, 'Enter a valid phone number'),
});
type AddressFormValues = z.infer<typeof addressFormSchema>;

export function AddressSummary({ address }: { address: ShippingAddress }) {
  return (
    <address className="text-sm not-italic leading-relaxed">
      <strong>{address.fullName}</strong>
      <br />
      {address.line1}
      {address.line2 ? `, ${address.line2}` : ''}
      <br />
      {address.city}, {address.region} {address.postalCode}
      <br />
      {address.country} · {address.phone}
    </address>
  );
}

// The buyer's delivery address, collected BEFORE payment (ADR-0045) so the
// seller knows where to send the parcel. Shows the saved address with an Edit
// button, or the form when none exists yet.
export function AddressForm({
  orderId,
  accessToken,
  address,
}: {
  orderId: string;
  accessToken: string;
  address: ShippingAddress | null;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<AddressFormValues>({
    resolver: zodResolver(addressFormSchema),
    defaultValues: address ? { ...address, line2: address.line2 ?? '' } : { country: 'IN' },
  });

  const save = useMutation({
    mutationFn: (values: AddressFormValues) =>
      saveShippingAddressRequest(accessToken, orderId, { ...values, line2: values.line2 ?? '' }),
    onSuccess: () => {
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
  });
  const error = save.error instanceof ApiError ? save.error.message : save.error ? 'Something went wrong. Please try again.' : null;

  if (address && !editing) {
    return (
      <div className="rounded-xl border-2 border-line bg-cream-2 p-4">
        <div className="mb-1 flex items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Delivering to</p>
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
            Edit
          </Button>
        </div>
        <AddressSummary address={address} />
      </div>
    );
  }

  const field = (name: keyof AddressFormValues, label: string, props: { placeholder?: string; autoComplete?: string } = {}) => (
    <Field label={label} htmlFor={`addr-${name}`} error={errors[name]?.message}>
      <input
        id={`addr-${name}`}
        type="text"
        aria-invalid={errors[name] ? true : undefined}
        {...register(name)}
        {...props}
        className={inputClass(!!errors[name])}
      />
    </Field>
  );

  return (
    <form onSubmit={handleSubmit((values) => save.mutate(values))} noValidate className="flex flex-col gap-3">
      <p className="text-sm text-ink/70">Where should the seller send it? You need this before you can pay.</p>
      {field('fullName', 'Full name', { autoComplete: 'name' })}
      {field('line1', 'Street address', { autoComplete: 'address-line1' })}
      {field('line2', 'Apartment, suite, etc. (optional)', { autoComplete: 'address-line2' })}
      <div className="grid grid-cols-2 gap-3">
        {field('city', 'City', { autoComplete: 'address-level2' })}
        {field('region', 'State / region', { autoComplete: 'address-level1' })}
      </div>
      <div className="grid grid-cols-2 gap-3">
        {field('postalCode', 'Postal code', { autoComplete: 'postal-code' })}
        {field('country', 'Country (2 letters)', { placeholder: 'IN', autoComplete: 'country' })}
      </div>
      {field('phone', 'Phone (for the courier)', { autoComplete: 'tel' })}
      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending} className="flex-1">
          {save.isPending ? 'Saving…' : 'Save address'}
        </Button>
        {address && (
          <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        )}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </form>
  );
}
