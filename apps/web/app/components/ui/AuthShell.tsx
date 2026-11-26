'use client';

import { IconEye, IconEyeOff } from '@tabler/icons-react';
import type { ComponentProps, ReactNode, Ref } from 'react';
import { useState } from 'react';
import { Input } from '@/components/wensity/input';

// Layout shared by the auth screens: a quiet statement on the left (hidden
// below `lg`) and one focused form card.
export function AuthShell({
  title,
  subtitle,
  footer,
  panelTitle,
  panelPoints,
  children,
}: {
  title: string;
  subtitle: string;
  footer: ReactNode;
  panelTitle: string;
  panelPoints: string[];
  children: ReactNode;
}) {
  return (
    <main className="mx-auto grid w-full max-w-5xl flex-1 items-center gap-16 px-6 py-12 lg:grid-cols-[1fr_26rem] lg:py-20">
      <aside className="hidden lg:block">
        <h2 className="max-w-md text-5xl font-medium leading-[1.06] tracking-tight">{panelTitle}</h2>
        <ol className="mt-10 border-t-2 border-foreground">
          {panelPoints.map((point, i) => (
            <li key={point} className="flex items-baseline gap-5 border-b border-border py-4">
              <span aria-hidden className="w-6 font-serif text-xl italic text-accent">
                {['i.', 'ii.', 'iii.', 'iv.', 'v.'][i]}
              </span>
              <span className="text-sm">{point}</span>
            </li>
          ))}
        </ol>
      </aside>

      <div className="panel mx-auto w-full max-w-md border-t-[3px] border-t-foreground p-6 sm:p-8">
        <h1 className="text-3xl font-medium tracking-tight">{title}</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>
        <div className="mt-6">{children}</div>
        <p className="mt-6 border-t border-border pt-5 text-center text-sm text-muted-foreground">{footer}</p>
      </div>
    </main>
  );
}

export function PasswordField({
  label,
  error,
  hint,
  id,
  ...props
}: Omit<ComponentProps<'input'>, 'type' | 'size' | 'ref'> & {
  label: string;
  error?: string;
  hint?: string;
  id: string;
  ref?: Ref<HTMLInputElement>;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="text-[13px] font-medium leading-none">
          {label}
        </label>
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-pressed={visible}
          aria-label={visible ? 'Hide password' : 'Show password'}
          className="-my-1 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          {visible ? <IconEyeOff className="size-4" stroke={1.6} /> : <IconEye className="size-4" stroke={1.6} />}
        </button>
      </div>
      <Input id={id} inputSize="lg" type={visible ? 'text' : 'password'} error={error} hint={hint} {...props} />
    </div>
  );
}
