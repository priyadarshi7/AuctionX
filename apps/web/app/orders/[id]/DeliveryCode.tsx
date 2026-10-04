'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ApiError } from '@/lib/apiClient';
import { confirmDeliveryRequest, regenerateDeliveryCodeRequest } from '@/lib/orders';
import type { Order } from '@/lib/types/order';
import { Button } from '../../components/ui/Button';
import { Field, inputClass } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';

// BUYER: shows the one-time delivery code (ADR-0045). It proves, when the
// seller enters it, that the parcel was really handed over to this buyer.
export function DeliveryCodePanel({ order, accessToken }: { order: Order; accessToken: string }) {
  const queryClient = useQueryClient();
  const regenerate = useMutation({
    mutationFn: () => regenerateDeliveryCodeRequest(accessToken, order.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['orders'] }),
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl border-2 border-line bg-yellow p-4 text-center">
        <p className="text-xs font-semibold uppercase tracking-wide">Your delivery code</p>
        <p aria-label={`Delivery code ${order.deliveryCode ?? ''}`} className="font-mono text-4xl font-extrabold tracking-[0.3em]">
          {order.deliveryCode ?? '------'}
        </p>
      </div>
      <p className="text-sm text-ink/70">
        Give this code to the courier or seller <strong>only when the parcel is in your hands</strong>. They enter it to
        complete the delivery. Never share it before that.
      </p>
      {order.deliveryCodeLocked && (
        <Notice tone="error">
          Too many wrong codes were entered, so delivery is locked. Generate a new code to continue.
        </Notice>
      )}
      <Button variant="secondary" size="sm" onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
        {regenerate.isPending ? 'Generating…' : 'Generate a new code'}
      </Button>
      {regenerate.isError && <Notice tone="error">Couldn’t generate a new code. Try again.</Notice>}
    </div>
  );
}

const codeSchema = z.object({ code: z.string().trim().regex(/^[0-9]{6}$/, 'Enter the 6-digit code') });
type CodeValues = z.infer<typeof codeSchema>;

// SELLER: completes the delivery by entering the code the buyer reads out.
export function DeliveryCodeForm({ order, accessToken }: { order: Order; accessToken: string }) {
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CodeValues>({ resolver: zodResolver(codeSchema) });

  const confirm = useMutation({
    mutationFn: ({ code }: CodeValues) => confirmDeliveryRequest(accessToken, order.id, code),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['orders'] }),
  });

  // The server's per-guess message ("... 3 tries left") lives in details.code.
  const detail =
    confirm.error instanceof ApiError &&
    typeof confirm.error.details === 'object' &&
    confirm.error.details !== null &&
    Array.isArray((confirm.error.details as { code?: unknown }).code)
      ? String(((confirm.error.details as { code: unknown[] }).code[0]) ?? '')
      : null;
  const error = confirm.error instanceof ApiError ? detail || confirm.error.message : confirm.error ? 'Something went wrong.' : null;

  if (order.deliveryCodeLocked) {
    return (
      <Notice tone="error">
        Too many wrong codes. Ask the buyer to generate a new delivery code on their order page, then try again.
      </Notice>
    );
  }

  return (
    <form onSubmit={handleSubmit((values) => confirm.mutate(values))} noValidate className="flex flex-col gap-3">
      <p className="text-sm text-ink/70">
        Shipped. When the buyer has the parcel, ask for their 6-digit delivery code and enter it to complete the order.
      </p>
      <Field label="Buyer’s delivery code" htmlFor="delivery-code" error={errors.code?.message}>
        <input
          id="delivery-code"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          maxLength={6}
          placeholder="000000"
          aria-invalid={errors.code ? true : undefined}
          {...register('code')}
          className={`${inputClass(!!errors.code)} font-mono tracking-[0.3em]`}
        />
      </Field>
      <Button type="submit" disabled={confirm.isPending} className="w-full">
        {confirm.isPending ? 'Checking…' : 'Confirm delivery'}
      </Button>
      {error && <Notice tone="error">{error}</Notice>}
    </form>
  );
}
