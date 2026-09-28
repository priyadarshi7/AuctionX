'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { ApiError } from '@/lib/apiClient';
import { loginRequest, registerRequest } from '@/lib/auth';
import { registerSchema, type RegisterFormValues } from '@/lib/validation/auth';
import { useAuthStore } from '@/store/authStore';
import { AuthShell, PasswordField } from '../components/ui/AuthShell';
import { Button } from '../components/ui/Button';
import { TextField } from '../components/ui/Field';
import { Notice } from '../components/ui/Notice';

export default function RegisterPage() {
  const router = useRouter();
  const setSession = useAuthStore((state) => state.setSession);
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RegisterFormValues>({ resolver: zodResolver(registerSchema) });

  const onSubmit = async (values: RegisterFormValues) => {
    setServerError(null);
    try {
      // POST /auth/register returns only the created user, not tokens
      // (AUTH-002) — registration and authentication are deliberately
      // separate concerns on the backend, so this logs in immediately
      // afterward with the same credentials rather than leaving the user
      // registered-but-signed-out.
      await registerRequest(values);
      const session = await loginRequest({ email: values.email, password: values.password });
      setSession(session.user, session.accessToken);
      router.push('/');
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    }
  };

  return (
    <AuthShell
      title="Create your account"
      subtitle="It takes about a minute. Then you can bid and sell."
      footer={
        <>
          Already have an account?{' '}
          <Link href="/login" className="font-semibold text-ink underline underline-offset-4">
            Log in
          </Link>
        </>
      }
      panelTitle="Bid on the stuff everyone wants."
      panelPoints={[
        'Every bid is verified by the server',
        'Anti-sniping keeps closing seconds fair',
        'One account to buy and to sell',
      ]}
    >
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
        <TextField
          id="name"
          label="Name"
          autoComplete="name"
          error={errors.name?.message}
          {...register('name')}
        />
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
          autoComplete="new-password"
          hint="At least 8 characters."
          error={errors.password?.message}
          {...register('password')}
        />
        {serverError && <Notice tone="error">{serverError}</Notice>}
        <Button type="submit" disabled={isSubmitting} className="mt-1 w-full">
          {isSubmitting ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
    </AuthShell>
  );
}
