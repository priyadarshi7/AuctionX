'use client';

import type { ComponentProps, ReactNode } from 'react';
import { useState } from 'react';
import { Mascot } from '../Mascot';
import { Field, inputClass } from './Field';

// Split layout shared by login and register: the form card on the left, a
// friendly cream-2 panel on the right that collapses away below `lg`.
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
    <main className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-10 px-6 py-10 lg:grid-cols-2 lg:py-16">
      <div className="mx-auto w-full max-w-md rounded-2xl border-2 border-ink bg-white p-6 shadow-hard sm:p-8">
        <h1 className="font-display text-3xl font-extrabold tracking-tight">{title}</h1>
        <p className="mt-1 text-ink/70">{subtitle}</p>
        <div className="mt-6">{children}</div>
        <p className="mt-6 border-t-2 border-ink/10 pt-4 text-sm text-ink/70">{footer}</p>
      </div>

      <aside className="bg-grid hidden flex-col items-start gap-6 rounded-2xl border-2 border-ink bg-cream-2 p-10 lg:flex">
        <Mascot className="h-28 w-28" />
        <h2 className="font-display text-3xl font-extrabold leading-tight">{panelTitle}</h2>
        <ul className="flex flex-col gap-3">
          {panelPoints.map((point) => (
            <li key={point} className="flex items-start gap-3">
              <span
                aria-hidden
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-ink bg-green text-[11px] font-extrabold leading-none"
              >
                &#10003;
              </span>
              {point}
            </li>
          ))}
        </ul>
      </aside>
    </main>
  );
}

export function PasswordField({
  label,
  error,
  hint,
  id,
  ...props
}: Omit<ComponentProps<'input'>, 'type'> & { label: string; error?: string; hint?: string; id: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <Field label={label} htmlFor={id} error={error} hint={hint}>
      <div className="relative">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          className={`${inputClass(!!error)} pr-16`}
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-pressed={visible}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full px-2.5 py-1 text-xs font-semibold hover:bg-cream-2"
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>
    </Field>
  );
}
