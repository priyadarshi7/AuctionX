"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Progressive Image Loading
 *
 * An image that holds its space and shows a placeholder until the real file
 * arrives, then develops in: it fades up from a soft blur and settles at full
 * sharpness, the way Medium and Facebook load photos.
 *
 * Placeholders, in order of how much they reveal:
 * - blur: a BlurHash string or a tiny preview image, blurred and scaled so
 *   its edges never show. BlurHash is decoded here, no package needed.
 * - color: a flat fill in the photo's main color. A BlurHash supplies it
 *   for free when no color is given.
 * - shimmer: a neutral surface with a light sweep, for when nothing about
 *   the image is known yet.
 *
 * The box is sized from `ratio`, or from `width` and `height`, so nothing
 * shifts when the image lands. Images already in the cache skip the
 * animation. A failed load shows a quiet error state with the alt text.
 * Reduced motion swaps the image in with a short fade instead.
 *
 * Pass `as` to render through another image component such as next/image;
 * it receives `src`, `alt`, `onLoad`, `onError`, the class names, `width` and
 * `height` when both are given, plus anything in `imageProps`. With only a
 * `ratio`, pass `imageProps={{ fill: true }}` for next/image.
 */

export type ProgressiveImagePlaceholder = "blur" | "color" | "shimmer";

export interface ProgressiveImageLoadingProps {
  /** Image url. While it is missing the placeholder stays up, for urls that arrive later. */
  src?: string;
  /** Alternative text. Also shown in the error state. */
  alt: string;
  /** Width over height, such as 4 / 3. Reserves the space before the image loads. */
  ratio?: number;
  /** Intrinsic width, used with height for the ratio when `ratio` is omitted. */
  width?: number;
  /** Intrinsic height, used with width for the ratio when `ratio` is omitted. */
  height?: number;
  /** Which placeholder to show. Defaults to blur when a BlurHash or preview is given, else color, else shimmer. */
  placeholder?: ProgressiveImagePlaceholder;
  /** BlurHash string for the blur placeholder, and the source of the main color. Decoded here, no package needed. */
  blurhash?: string;
  /** Tiny preview image (a data URL or a 20px wide file) for the blur placeholder. */
  blurDataURL?: string;
  /** Main color of the photo, for the color placeholder. */
  color?: string;
  /** Length of the develop animation, in milliseconds. Default 700. */
  duration?: number;
  /** Native lazy loading. Default "lazy". */
  loading?: "lazy" | "eager";
  sizes?: string;
  srcSet?: string;
  /** Render the image through another component, such as next/image. */
  as?: React.ElementType;
  /** Extra props for the image element, such as `priority`, or `fill` for next/image when only `ratio` is set. */
  imageProps?: Record<string, unknown>;
  onLoad?: () => void;
  onError?: () => void;
  /** Classes for the frame: radius, width, shadow. */
  className?: string;
  /** Classes for the image itself, such as object-position. */
  imageClassName?: string;
  style?: React.CSSProperties;
}

type Phase = "waiting" | "loaded" | "settled" | "error";

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";
const BASE83 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";
/** Side of the decoded BlurHash bitmap. Tiny on purpose: it is blurred and scaled up anyway. */
const BLURHASH_SIZE = 32;
const SHIMMER_ID = "wensity-progressive-image";
const SHIMMER_CSS = `
@keyframes wensity-pi-sweep { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
`;

function ensureShimmer() {
  if (typeof document === "undefined" || document.getElementById(SHIMMER_ID)) return;
  const style = document.createElement("style");
  style.id = SHIMMER_ID;
  style.textContent = SHIMMER_CSS;
  document.head.appendChild(style);
}

function decode83(text: string) {
  let value = 0;
  for (const char of text) {
    const digit = BASE83.indexOf(char);
    if (digit < 0) return -1;
    value = value * 83 + digit;
  }
  return value;
}

function toLinear(channel: number) {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function toSRGB(value: number) {
  const v = Math.max(0, Math.min(1, value));
  return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
}

function signedPow(value: number, exponent: number) {
  return Math.sign(value) * Math.abs(value) ** exponent;
}

interface DecodedHash {
  /** Main color: the average the hash stores first. */
  color: string;
  /** Decoded bitmap, ready for a canvas. */
  pixels: Uint8ClampedArray;
}

/**
 * BlurHash decoder, written from the published format: a size byte, a
 * quantized maximum, one average color, then cosine components that add up
 * to a soft picture. Returns null for anything malformed.
 */
function decodeBlurhash(hash: string, size: number): DecodedHash | null {
  if (!hash || hash.length < 6) return null;
  const sizeFlag = decode83(hash[0]);
  if (sizeFlag < 0) return null;
  const numY = Math.floor(sizeFlag / 9) + 1;
  const numX = (sizeFlag % 9) + 1;
  if (hash.length !== 4 + 2 * numX * numY) return null;
  const maxValue = (decode83(hash[1]) + 1) / 166;

  const colors: Array<[number, number, number]> = [];
  for (let i = 0; i < numX * numY; i++) {
    if (i === 0) {
      const value = decode83(hash.slice(2, 6));
      if (value < 0) return null;
      colors.push([toLinear(value >> 16), toLinear((value >> 8) & 255), toLinear(value & 255)]);
    } else {
      const value = decode83(hash.slice(4 + i * 2, 6 + i * 2));
      if (value < 0) return null;
      const r = Math.floor(value / (19 * 19));
      const g = Math.floor(value / 19) % 19;
      const b = value % 19;
      colors.push([
        signedPow((r - 9) / 9, 2) * maxValue,
        signedPow((g - 9) / 9, 2) * maxValue,
        signedPow((b - 9) / 9, 2) * maxValue,
      ]);
    }
  }

  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < numY; j++) {
        const by = Math.cos((Math.PI * y * j) / size);
        for (let i = 0; i < numX; i++) {
          const basis = Math.cos((Math.PI * x * i) / size) * by;
          const c = colors[i + j * numX];
          r += c[0] * basis;
          g += c[1] * basis;
          b += c[2] * basis;
        }
      }
      const at = (y * size + x) * 4;
      pixels[at] = toSRGB(r);
      pixels[at + 1] = toSRGB(g);
      pixels[at + 2] = toSRGB(b);
      pixels[at + 3] = 255;
    }
  }

  const [dr, dg, db] = colors[0];
  return { color: `rgb(${toSRGB(dr)} ${toSRGB(dg)} ${toSRGB(db)})`, pixels };
}

/** The average color is cheap to read without decoding the whole hash. */
function hashColor(hash: string | undefined) {
  if (!hash || hash.length < 6) return undefined;
  const value = decode83(hash.slice(2, 6));
  if (value < 0) return undefined;
  return `rgb(${value >> 16} ${(value >> 8) & 255} ${value & 255})`;
}

/** Reduced motion as a subscription, so server and client render the same markup. */
function subscribeReduced(onChange: () => void) {
  const query = window.matchMedia(REDUCED_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function useReducedMotion() {
  return React.useSyncExternalStore(
    subscribeReduced,
    () => window.matchMedia(REDUCED_QUERY).matches,
    () => false,
  );
}

export function ProgressiveImageLoading({
  src,
  alt,
  ratio,
  width,
  height,
  placeholder,
  blurhash,
  blurDataURL,
  color,
  duration = 700,
  loading = "lazy",
  sizes,
  srcSet,
  as: ImageComponent = "img",
  imageProps,
  onLoad,
  onError,
  className,
  imageClassName,
  style,
}: ProgressiveImageLoadingProps) {
  const [phase, setPhase] = React.useState<Phase>("waiting");
  const [instant, setInstant] = React.useState(false);
  const imageRef = React.useRef<HTMLImageElement | null>(null);
  const reduced = useReducedMotion();

  const mode: ProgressiveImagePlaceholder =
    placeholder ?? (blurhash || blurDataURL ? "blur" : color ? "color" : "shimmer");
  const fill = color ?? hashColor(blurhash);
  const aspect = ratio ?? (width && height ? width / height : undefined);

  // A new image starts over from the placeholder.
  const [trackedSrc, setTrackedSrc] = React.useState(src);
  if (trackedSrc !== src) {
    setTrackedSrc(src);
    setPhase("waiting");
    setInstant(false);
  }

  // Paint the BlurHash straight onto a tiny canvas as it mounts: no state, no extra render.
  const paintHash = React.useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas || !blurhash) return;
      const decoded = decodeBlurhash(blurhash, BLURHASH_SIZE);
      const ctx = canvas.getContext("2d");
      if (!decoded || !ctx) return;
      const image = ctx.createImageData(BLURHASH_SIZE, BLURHASH_SIZE);
      image.data.set(decoded.pixels);
      ctx.putImageData(image, 0, 0);
    },
    [blurhash],
  );

  React.useEffect(() => {
    if (mode === "shimmer") ensureShimmer();
  }, [mode]);

  // An image already in the cache can finish before React attaches onLoad. Catch
  // it, and show it at once: animating a photo the reader already has is noise.
  React.useEffect(() => {
    const node = imageRef.current;
    if (!src || !node || !("complete" in node)) return;
    if (node.complete && node.naturalWidth > 0) {
      setInstant(true);
      setPhase("settled");
    }
  }, [src]);

  // After the develop animation, drop the placeholder so no halo shows at the edges.
  React.useEffect(() => {
    if (phase !== "loaded") return;
    const wait = reduced ? 160 : duration;
    const timer = window.setTimeout(() => setPhase("settled"), wait + 60);
    return () => window.clearTimeout(timer);
  }, [phase, duration, reduced]);

  const handleLoad = () => {
    setPhase((current) => (current === "settled" ? current : "loaded"));
    onLoad?.();
  };

  const handleError = () => {
    setPhase("error");
    onError?.();
  };

  const shown = phase === "loaded" || phase === "settled";
  // Any image component works here, so its props are typed loosely on purpose.
  const Img = ImageComponent as unknown as React.ComponentType<Record<string, unknown>>;
  // Intrinsic size reaches the image too: next/image requires it unless it is
  // told to fill, and it rejects both at once. A plain img just ignores it for
  // layout, since the frame sizes the image.
  const intrinsic = imageProps?.fill || !width || !height ? {} : { width, height };
  const ms = instant ? 0 : reduced ? 160 : duration;

  const imageStyle: React.CSSProperties = {
    opacity: shown ? 1 : 0,
    filter: shown || reduced ? "none" : "blur(18px) saturate(1.25)",
    transform: shown || reduced ? "none" : "scale(1.04)",
    transition: ms
      ? `opacity ${ms}ms cubic-bezier(0.2, 0.7, 0.2, 1), filter ${ms}ms cubic-bezier(0.2, 0.7, 0.2, 1), transform ${ms * 1.2}ms cubic-bezier(0.2, 0.7, 0.2, 1)`
      : "none",
  };

  return (
    <div
      className={cn("relative isolate w-full overflow-hidden bg-neutral-200 dark:bg-neutral-800", className)}
      style={{ aspectRatio: aspect, ...style }}
      aria-busy={!shown && phase !== "error" ? true : undefined}
    >
      {/* Placeholder, under the image until the image has settled. */}
      {phase !== "settled" && phase !== "error" && (
        <div aria-hidden className="absolute inset-0" style={{ backgroundColor: fill }}>
          {/* Blurred and overscaled, so the soft edges of the preview never show. */}
          {mode === "blur" && blurDataURL && (
            <div
              className="absolute -inset-[8%] bg-cover bg-center"
              style={{ backgroundImage: `url(${blurDataURL})`, filter: "blur(24px) saturate(1.15)" }}
            />
          )}
          {mode === "blur" && !blurDataURL && blurhash && (
            <canvas
              ref={paintHash}
              width={BLURHASH_SIZE}
              height={BLURHASH_SIZE}
              className="absolute -inset-[8%] size-[116%]"
              style={{ filter: "blur(18px) saturate(1.15)" }}
            />
          )}
          {mode === "shimmer" && (
            <div className="absolute inset-0 overflow-hidden">
              <div
                className="absolute inset-0 motion-reduce:hidden"
                style={{
                  background:
                    "linear-gradient(100deg, transparent 20%, rgba(255,255,255,0.28) 45%, rgba(255,255,255,0.42) 50%, rgba(255,255,255,0.28) 55%, transparent 80%)",
                  animation: "wensity-pi-sweep 1.5s cubic-bezier(0.4, 0, 0.2, 1) infinite",
                }}
              />
            </div>
          )}
        </div>
      )}

      {src && phase !== "error" && (
        <Img
          ref={imageRef}
          src={src}
          alt={alt}
          sizes={sizes}
          srcSet={srcSet}
          loading={loading}
          decoding="async"
          onLoad={handleLoad}
          onError={handleError}
          className={cn("absolute inset-0 size-full object-cover", imageClassName)}
          style={imageStyle}
          {...intrinsic}
          {...imageProps}
        />
      )}

      {phase === "error" && (
        <div
          role="img"
          aria-label={alt}
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-neutral-100 px-4 text-center text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400"
        >
          <svg aria-hidden width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 8h.01" />
            <path d="M7 3h11a3 3 0 0 1 3 3v11m-.856 3.099a3 3 0 0 1-2.144.901h-12a3 3 0 0 1-3-3v-12c0-.845.349-1.608.91-2.153" />
            <path d="M3 16l5-5c.928-.893 2.072-.893 3 0l5 5" />
            <path d="M16.33 12.338c.574-.054 1.155.166 1.67.662l3 3" />
            <path d="M3 3l18 18" />
          </svg>
          <span className="line-clamp-2 max-w-[24ch] text-xs leading-snug">{alt}</span>
        </div>
      )}
    </div>
  );
}
