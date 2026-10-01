'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { ApiError } from '@/lib/apiClient';
import { resetPasswordRequest } from '@/lib/auth';
import { resetPasswordSchema, type ResetPasswordFormValues } from '@/lib/validation/auth';
import { AuthShell, PasswordField } from '../components/ui/AuthShell';
import { Button } from '../components/ui/Button';
import { Notice } from '../components/ui/Notice';

export function ResetPasswordView() {
  const router = useRouter();
  const token = useSearchParams().get('token');
  const [serverError, setServerError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordFormValues>({ resolver: zodResolver(resetPasswordSchema) });

  const onSubmit = async (values: ResetPasswordFormValues) => {
    if (!token) return;
    setServerError(null);
    try {
      await resetPasswordRequest(token, values.newPassword);
      setDone(true);
    } catch (err) {
      // Covers INVALID_RESET_TOKEN (expired/used/malformed) via the same
      // generic message the backend already returns — no reason to
      // interpret it further here.
      setServerError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    }
  };

  const shellProps = {
    title: 'Set a new password',
    footer: (
      <>
        Back to{' '}
        <Link href="/login" className="font-semibold text-ink underline underline-offset-4">
          Log in
        </Link>
      </>
    ),
    panelTitle: 'Almost there.',
    panelPoints: [
      'Resetting your password signs out every other session',
      'Use a password you don’t use anywhere else',
    ],
  };

  if (!token) {
    return (
      <AuthShell {...shellProps} subtitle="This link is missing its token.">
        <Notice tone="error">
          This password reset link looks incomplete. Request a new one from{' '}
          <Link href="/forgot-password" className="font-semibold underline underline-offset-4">
            the reset page
          </Link>
          .
        </Notice>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell {...shellProps} subtitle="Your password has been changed.">
        <Notice tone="success">
          Your password has been reset. All other sessions have been signed out for your security.
        </Notice>
        <Button className="mt-4 w-full" onClick={() => router.push('/login')}>
          Log in
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell {...shellProps} subtitle="Choose a new password for your account.">
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
        <PasswordField
          id="newPassword"
          label="New password"
          autoComplete="new-password"
          hint="At least 8 characters."
          error={errors.newPassword?.message}
          {...register('newPassword')}
        />
        {serverError && <Notice tone="error">{serverError}</Notice>}
        <Button type="submit" disabled={isSubmitting} className="mt-1 w-full">
          {isSubmitting ? 'Resetting…' : 'Reset password'}
        </Button>
      </form>
    </AuthShell>
  );
}
