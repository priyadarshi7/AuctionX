'use client';

import { useState } from 'react';
import { Mascot } from '../../components/Mascot';

// Main image plus a thumbnail strip. Clicking a thumbnail swaps the main
// image; the strip is a radio-like group so keyboard and screen-reader
// users can do the same.
export function Gallery({ images, title }: { images: string[]; title: string }) {
  const [index, setIndex] = useState(0);
  const current = images[Math.min(index, images.length - 1)];

  return (
    <div className="flex flex-col gap-3">
      <div className="aspect-square overflow-hidden rounded-2xl border-2 border-line bg-cream-2 shadow-hard-sm">
        {current ? (
          // Storage domain isn't fixed yet (local s3mock vs. prod R2), so
          // next/image's remotePatterns can't be configured until
          // deployment — see app/auctions/new/page.tsx's comment.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={current} alt={title} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Mascot className="h-32 w-32 opacity-70" />
          </div>
        )}
      </div>

      {images.length > 1 && (
        <div role="group" aria-label="Photos" className="flex gap-2 overflow-x-auto pb-1">
          {images.map((url, i) => (
            <button
              key={url}
              type="button"
              aria-label={`Show photo ${i + 1} of ${images.length}`}
              aria-pressed={i === index}
              onClick={() => setIndex(i)}
              className={`h-16 w-16 shrink-0 overflow-hidden rounded-xl border-2 border-line transition-opacity ${
                i === index ? 'shadow-hard-sm' : 'opacity-60 hover:opacity-100'
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt="" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
