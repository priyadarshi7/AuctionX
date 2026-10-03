import type { ComponentProps, ReactNode } from 'react';

// One error treatment everywhere: a pink offset shadow on the control plus
// a "!" message underneath. Colour is never the only signal — the message
// text and icon carry it (and aria-invalid tells assistive tech).
export function inputClass(hasError: boolean): string {
  return `w-full rounded-xl border-2 border-line bg-white px-3.5 py-2.5 text-base placeholder:text-ink/50 transition-shadow disabled:opacity-60 ${
    hasError ? 'shadow-[3px_3px_0_0_var(--pink)]' : 'focus:shadow-hard-sm'
  }`;
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-semibold">
        {label}
      </label>
      {children}
      {hint && !error && (
        <p id={`${htmlFor}-hint`} className="mt-1.5 text-sm text-ink/60">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${htmlFor}-error`} className="mt-1.5 flex items-center gap-1.5 text-sm font-medium">
          <span
            aria-hidden
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 border-line bg-pink text-[10px] font-extrabold leading-none"
          >
            !
          </span>
          {error}
        </p>
      )}
    </div>
  );
}

type Shared = { label: string; error?: string; hint?: string };

export function TextField({ label, error, hint, id, className = '', ...props }: ComponentProps<'input'> & Shared & { id: string }) {
  return (
    <Field label={label} htmlFor={id} error={error} hint={hint}>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={`${inputClass(!!error)} ${className}`}
        {...props}
      />
    </Field>
  );
}

export function TextArea({ label, error, hint, id, className = '', ...props }: ComponentProps<'textarea'> & Shared & { id: string }) {
  return (
    <Field label={label} htmlFor={id} error={error} hint={hint}>
      <textarea
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={`${inputClass(!!error)} ${className}`}
        {...props}
      />
    </Field>
  );
}

export function SelectField({
  label,
  error,
  hint,
  id,
  className = '',
  children,
  ...props
}: ComponentProps<'select'> & Shared & { id: string }) {
  return (
    <Field label={label} htmlFor={id} error={error} hint={hint}>
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        className={`${inputClass(!!error)} ${className}`}
        {...props}
      >
        {children}
      </select>
    </Field>
  );
}
