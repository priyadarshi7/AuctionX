'use client';

import { IconPhoto } from '@tabler/icons-react';
import { ProgressiveImageLoading } from '@/components/wensity/progressive-image-loading';

// A mounted photograph: holds its shape while loading, and says so plainly
// when a lot has no photo. Plain <img> underneath — the storage domain isn't
// fixed yet (local s3mock vs. prod R2), so next/image's remotePatterns can't
// be configured until deployment.
export function Plate({
  src,
  alt,
  ratio = 1,
  className = '',
  imageClassName = '',
  eager = false,
}: {
  src?: string;
  alt: string;
  ratio?: number;
  className?: string;
  imageClassName?: string;
  eager?: boolean;
}) {
  return (
    <div className={`plate ${className}`}>
      {src ? (
        <ProgressiveImageLoading
          src={src}
          alt={alt}
          ratio={ratio}
          placeholder="color"
          color="var(--surface-muted)"
          loading={eager ? 'eager' : 'lazy'}
          className="w-full overflow-hidden rounded-none"
          imageClassName={`object-cover ${imageClassName}`}
        />
      ) : (
        <div
          className="flex w-full flex-col items-center justify-center gap-2 bg-surface-muted text-muted-foreground"
          style={{ aspectRatio: ratio }}
        >
          <IconPhoto aria-hidden className="size-7 opacity-60" stroke={1} />
          <span className="eyebrow">No plate</span>
        </div>
      )}
    </div>
  );
}
