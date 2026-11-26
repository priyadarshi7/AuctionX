import Link from 'next/link';
import type { ComponentProps } from 'react';
import {
  Button as WButton,
  buttonSurface,
  buttonVariants,
  type ButtonSize,
  type ButtonVariant,
} from '@/components/wensity/button';

// The app's button vocabulary, mapped onto the Wensity primitive. Pages say
// what a button MEANS (primary, danger…); this file decides how it looks.
type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'md' | 'sm';

const VARIANT: Record<Variant, ButtonVariant> = {
  primary: 'default',
  secondary: 'secondary',
  danger: 'outline',
  ghost: 'ghost',
};
const SIZE: Record<Size, ButtonSize> = { md: 'lg', sm: 'sm' };
const EXTRA: Record<Variant, string> = { primary: '', secondary: '', danger: 'text-urgent', ghost: '' };

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}: Omit<ComponentProps<'button'>, 'ref'> & { variant?: Variant; size?: Size; loading?: boolean }) {
  return (
    <WButton
      variant={VARIANT[variant]}
      size={SIZE[size]}
      className={`${EXTRA[variant]} ${className}`}
      {...props}
    />
  );
}

// A real <a> that looks like a button. The data attributes are what the
// Wensity surface styles hook onto.
export function ButtonLink({
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}: ComponentProps<typeof Link> & { variant?: Variant; size?: Size }) {
  return (
    <Link
      data-wensity-primitive=""
      data-surface={buttonSurface[VARIANT[variant]]}
      className={buttonVariants({
        variant: VARIANT[variant],
        size: SIZE[size],
        className: `${EXTRA[variant]} ${className}`,
      })}
      {...props}
    />
  );
}
