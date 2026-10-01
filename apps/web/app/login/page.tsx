'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { ApiError } from '@/lib/apiClient';
import { loginRequest } from '@/lib/auth';
import { loginSchema, type LoginFormValues } from '@/lib/validation/auth';
import { useAuthStore } from '@/store/authStore';
import { AuthShell, PasswordField } from '../components/ui/AuthShell';
import { Button } from '../components/ui/Button';
import { TextField } from '../components/ui/Field';
import { Notice } from '../components/ui/Notice';

export default function LoginPage() {
  const router = useRouter();
  const setSession = useAuthStore((state) => state.setSession);
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({ resolver: zodResolver(loginSchema) });

  const onSubmit = async (values: LoginFormValues) => {
    setServerError(null);
    try {
      const session = await loginRequest(values);
      setSession(session.user, session.accessToken);
      router.push('/');
    } catch (err) {
      // INVALID_CREDENTIALS is deliberately identical whether the email
      // doesn't exist or the password is wrong (AUTH-003's enumeration-
      // safety design) — this just displays whatever message the backend
      // sent, it doesn't need to know why.
      setServerError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    }
  };

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Log in to bid, sell and check your orders."
      footer={
        <>
          New here?{' '}
          <Link href="/register" className="font-semibold text-ink underline underline-offset-4">
            Create an account
          </Link>
        </>
      }
      panelTitle="The floor's open. Your watchlist is waiting."
      panelPoints={[
        'Live bids, updated the instant they land',
        'Outbid alerts so you never miss a win',
        'Pay and track every order in one place',
      ]}
    >
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
        <TextField
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          error={errors.email?.message}
          {...register('email')}
        />
        <PasswordField
          id="password"
          label="Password"
          autoComplete="current-password"
          error={errors.password?.message}
          {...register('password')}
        />
        <Link
          href="/forgot-password"
          className="-mt-2 self-end text-sm font-semibold text-ink/70 underline underline-offset-4 hover:text-ink"
        >
          Forgot password?
        </Link>
        {serverError && <Notice tone="error">{serverError}</Notice>}
        <Button type="submit" disabled={isSubmitting} className="mt-1 w-full">
          {isSubmitting ? 'Logging in…' : 'Log in'}
        </Button>
      </form>
    </AuthShell>
  );
}
