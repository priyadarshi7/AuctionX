import type { ReactNode } from 'react';
import { Mascot } from '../Mascot';

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-display text-4xl font-extrabold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-2 text-ink/70">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

// Full-width message block used for "not found", "couldn't load" and
// empty lists, so every page fails the same friendly way.
export function PageMessage({
  title,
  body,
  action,
  mascotColor = '#66d9e8',
}: {
  title: string;
  body?: string;
  action?: ReactNode;
  mascotColor?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-line/30 px-6 py-14 text-center">
      <Mascot className="h-16 w-16" color={mascotColor} />
      <p className="font-display text-xl font-bold">{title}</p>
      {body && <p className="max-w-md text-ink/70">{body}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-xl bg-cream-2 ${className}`} />;
}

// Shown while the session is still being resolved or a redirect to /login
// is in flight — a neutral skeleton, not a flash of protected content.
export function PageLoading() {
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10" aria-busy="true">
      <Skeleton className="h-10 w-64" />
      <Skeleton className="mt-3 h-5 w-96 max-w-full" />
      <Skeleton className="mt-8 h-64 w-full" />
    </main>
  );
}
