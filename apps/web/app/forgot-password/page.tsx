'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { ApiError } from '@/lib/apiClient';
import { forgotPasswordRequest } from '@/lib/auth';
import { forgotPasswordSchema, type ForgotPasswordFormValues } from '@/lib/validation/auth';
import { AuthShell } from '../components/ui/AuthShell';
import { Button } from '../components/ui/Button';
import { TextField } from '../components/ui/Field';
import { Notice } from '../components/ui/Notice';

export default function ForgotPasswordPage() {
  const [serverError, setServerError] = useState<string | null>(null);
  // Always the same message regardless of what actually happened server-side
  // (services/api's requestPasswordReset is deliberately enumeration-safe —
  // see its doc comment) — the frontend must not undermine that by, say,
  // showing a different message for a network/validation error that leaks
  // whether the call even reached the account-lookup step. A thrown
  // ApiError is still shown (a malformed email, a 429, etc.) since those
  // are about the request itself, not about whether the account exists.
  const [sent, setSent] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordFormValues>({ resolver: zodResolver(forgotPasswordSchema) });

  const onSubmit = async (values: ForgotPasswordFormValues) => {
    setServerError(null);
    try {
      await forgotPasswordRequest(values);
      setSent(true);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    }
  };

  return (
    <AuthShell
      title="Reset your password"
      subtitle="Enter the email on your account and we'll send a reset link."
      footer={
        <>
          Remembered it after all?{' '}
          <Link href="/login" className="font-semibold text-ink underline underline-offset-4">
            Log in
          </Link>
        </>
      }
      panelTitle="Back in, in a minute."
      panelPoints={[
        'Reset links expire in 30 minutes',
        'Using one signs you out everywhere else',
        "We'll never say whether an email is registered",
      ]}
    >
      {sent ? (
        <Notice tone="success">
          If an account with that email exists, a password reset link has been sent. Check your inbox.
        </Notice>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
          <TextField
            id="email"
            label="Email"
            type="email"
            autoComplete="email"
            error={errors.email?.message}
            {...register('email')}
          />
          {serverError && <Notice tone="error">{serverError}</Notice>}
          <Button type="submit" disabled={isSubmitting} className="mt-1 w-full">
            {isSubmitting ? 'Sending…' : 'Send reset link'}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
