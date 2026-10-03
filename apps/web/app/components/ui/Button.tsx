import Link from 'next/link';
import type { ComponentProps } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'md' | 'sm';

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-full border-2 border-line font-display font-bold transition-[transform,background-color] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-yellow shadow-hard-sm hover:-translate-y-0.5 hover:shadow-hard',
  secondary: 'bg-white hover:-translate-y-0.5 hover:bg-cream-2',
  danger: 'bg-white hover:bg-pink',
  ghost: 'border-transparent hover:bg-cream-2',
};

const SIZES: Record<Size, string> = {
  md: 'px-6 py-2.5 text-base',
  sm: 'px-4 py-1.5 text-sm',
};

// Exported so a <Link> (or anything else) can borrow the look without
// being a <button>.
export function buttonClass(variant: Variant = 'primary', size: Size = 'md', extra = ''): string {
  return `${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${extra}`.trim();
}

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  type = 'button',
  ...props
}: ComponentProps<'button'> & { variant?: Variant; size?: Size }) {
  return <button type={type} className={buttonClass(variant, size, className)} {...props} />;
}

export function ButtonLink({
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}: ComponentProps<typeof Link> & { variant?: Variant; size?: Size }) {
  return <Link className={buttonClass(variant, size, className)} {...props} />;
}
