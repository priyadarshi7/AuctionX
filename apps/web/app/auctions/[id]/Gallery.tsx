'use client';

import { IconChevronLeft, IconChevronRight, IconMaximize, IconPhoto } from '@tabler/icons-react';
import { useState } from 'react';
import { Dialog, DialogContent } from '@/components/wensity/dialog';

// Main image plus a thumbnail strip. Clicking a thumbnail swaps the main
// image; clicking the main image opens a full-size lightbox with arrow keys.
export function Gallery({ images, title }: { images: string[]; title: string }) {
  const [index, setIndex] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const safeIndex = Math.min(index, Math.max(images.length - 1, 0));
  const current = images[safeIndex];
  const step = (delta: number) => setIndex((safeIndex + delta + images.length) % images.length);

  const arrowClass =
    'absolute top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/65 text-white backdrop-blur-md transition-colors hover:bg-black/85';

  return (
    <div className="flex flex-col gap-3">
      <div className="plate p-3!">
        <div className="relative aspect-square overflow-hidden">
        {current ? (
          <button
            type="button"
            onClick={() => setZoomed(true)}
            aria-label="View photo full size"
            className="group block h-full w-full cursor-zoom-in focus-visible:-outline-offset-2"
          >
            {/* Storage domain isn't fixed yet (local s3mock vs. prod R2), so
                next/image's remotePatterns can't be configured until
                deployment — see app/auctions/new/page.tsx's comment. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={current} alt={title} className="h-full w-full object-cover" />
            <span
              aria-hidden
              className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-lg bg-black/65 text-white opacity-0 backdrop-blur-md transition-opacity group-hover:opacity-100"
            >
              <IconMaximize className="size-4" stroke={1.7} />
            </span>
          </button>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 bg-surface-muted text-muted-foreground">
            <IconPhoto aria-hidden className="size-10 opacity-50" stroke={1.2} />
            <span className="eyebrow">No plate</span>
          </div>
        )}
        </div>
      </div>

      {images.length > 1 && (
        <div role="group" aria-label="Photos" className="flex gap-2 overflow-x-auto p-0.5">
          {images.map((url, i) => (
            <button
              key={url}
              type="button"
              aria-label={`Show photo ${i + 1} of ${images.length}`}
              aria-pressed={i === safeIndex}
              onClick={() => setIndex(i)}
              className={`size-16 shrink-0 overflow-hidden border-2 transition-all ${
                i === safeIndex ? 'border-accent' : 'border-transparent opacity-55 hover:opacity-100'
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt="" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      )}

      <Dialog open={zoomed} onOpenChange={setZoomed}>
        <DialogContent accessibilityTitle={title} className="max-w-4xl overflow-hidden p-0">
          <div
            className="relative"
            onKeyDown={(event) => {
              if (images.length < 2) return;
              if (event.key === 'ArrowLeft') step(-1);
              if (event.key === 'ArrowRight') step(1);
            }}
          >
            {current && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={current} alt={title} className="max-h-[82vh] w-full bg-black object-contain" />
            )}
            {images.length > 1 && (
              <>
                <button type="button" aria-label="Previous photo" onClick={() => step(-1)} className={`${arrowClass} left-3`}>
                  <IconChevronLeft className="size-5" />
                </button>
                <button type="button" aria-label="Next photo" onClick={() => step(1)} className={`${arrowClass} right-3`}>
                  <IconChevronRight className="size-5" />
                </button>
                <span className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/65 px-3 py-1 font-mono text-xs text-white">
                  {safeIndex + 1} / {images.length}
                </span>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
