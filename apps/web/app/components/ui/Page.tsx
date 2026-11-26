import { IconMoodEmpty, type Icon } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { Skeleton as WSkeleton } from '@/components/wensity/skeleton';

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
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4 border-b-2 border-foreground pb-5">
      <div>
        <h1 className="text-4xl font-medium tracking-tight sm:text-5xl">{title}</h1>
        {subtitle && <p className="mt-2 font-serif text-lg italic text-muted-foreground">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

// Full-width message block used for "not found", "couldn't load" and empty
// lists, so every page fails the same calm way.
export function PageMessage({
  title,
  body,
  action,
  icon: MessageIcon = IconMoodEmpty,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
  icon?: Icon;
}) {
  return (
    <div className="flex flex-col items-center border-y border-border-strong px-6 py-16 text-center">
      <MessageIcon aria-hidden className="mb-4 size-7 text-muted-foreground" stroke={1} />
      <p className="font-serif text-2xl">{title}</p>
      {body && <p className="mt-1.5 max-w-md text-sm text-muted-foreground">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <WSkeleton aria-hidden variant="custom" className={className} />;
}

// Shown while the session is still being resolved or a redirect to /login
// is in flight — a neutral skeleton, not a flash of protected content.
export function PageLoading() {
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10" aria-busy="true">
      <Skeleton className="h-9 w-56" />
      <Skeleton className="mt-3 h-4 w-80 max-w-full" />
      <Skeleton className="mt-8 h-64 w-full rounded-2xl" />
    </main>
  );
}
