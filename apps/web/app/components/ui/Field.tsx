import type { ComponentProps, ReactNode, Ref } from 'react';
import { Input } from '@/components/wensity/input';
import { NativeSelect } from '@/components/wensity/native-select';
import { Textarea } from '@/components/wensity/text-area';

// For the few raw controls that need custom adornments (the bid amount, row
// selects); everything else uses the Wensity fields below.
export function inputClass(hasError: boolean): string {
  return `h-10 w-full rounded-xl border bg-surface px-3.5 text-sm text-foreground outline-none transition-colors placeholder:text-primitive-text-placeholder focus-visible:ring-2 focus-visible:ring-primitive-ring disabled:opacity-50 ${
    hasError ? 'border-urgent' : 'border-border hover:border-border-strong'
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
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[13px] font-medium leading-none">
        {label}
      </label>
      {children}
      {hint && !error && (
        <p id={`${htmlFor}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${htmlFor}-error`} className="text-xs text-urgent">
          {error}
        </p>
      )}
    </div>
  );
}

type Shared = { label: string; error?: string; hint?: string; id: string };

export function TextField(
  props: Omit<ComponentProps<'input'>, 'size' | 'ref'> & Shared & { ref?: Ref<HTMLInputElement> },
) {
  return <Input inputSize="lg" {...props} />;
}

export function TextArea(
  props: Omit<ComponentProps<'textarea'>, 'ref'> & Shared & { ref?: Ref<HTMLTextAreaElement> },
) {
  return <Textarea {...props} />;
}

export function SelectField({ children, ...props }: Omit<ComponentProps<'select'>, 'size'> & Shared) {
  return (
    <NativeSelect selectSize="lg" {...props}>
      {children}
    </NativeSelect>
  );
}
