"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export type TextScribbleType = "scribble" | "underline" | "strike-through" | "circle" | "box";
export type TextScribbleTrigger = "view" | "hover" | "mount";

export interface TextScribbleProps {
  /** The inline content to annotate. */
  children: React.ReactNode;
  /** Annotation style. Default: `"scribble"`. */
  type?: TextScribbleType;
  /** Stroke color. Defaults to the Wensity brand (chili). */
  color?: string;
  /** Stroke width in CSS pixels. Default: 2. */
  strokeWidth?: number;
  /** Seconds for the draw-on. Default: 0.9. */
  duration?: number;
  /** Seconds to wait before drawing. Default: 0. */
  delay?: number;
  /** When to draw. Default: `"view"`. */
  trigger?: TextScribbleTrigger;
  /**
   * Sketch passes for the hand-drawn look. More = scratchier. Clamped 1–4.
   * Default: 2 for `scribble`, 1 otherwise.
   */
  iterations?: number;
  /** Extra px around the text before the mark is drawn. Default: 2. */
  padding?: number;
  /**
   * Force the draw state. `true` keeps it drawn, `false` retracted; when
   * omitted the `trigger` drives it. Reduced-motion always draws instantly.
   */
  drawn?: boolean;
  /** Outer element tag. Default: `"span"`. */
  as?: keyof React.JSX.IntrinsicElements;
  /** Tailwind class for the host (size / weight / color of the text). */
  className?: string;
  /** Optional accessible name override for the host. */
  "aria-label"?: string;
}

type Mark = { d: string; delay: number };

/** Wensity brand (chili). Falls back to the literal for copied-out source. */
const DEFAULT_COLOR = "var(--color-chili-500, #cd1c18)";

/** Tiny deterministic PRNG so passes look sketchy but stay stable per size. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A near-horizontal line with light vertical jitter — a felt-tip stroke. */
function jitterLine(x1: number, x2: number, y: number, amp: number, rng: () => number) {
  const span = x2 - x1;
  const steps = Math.max(2, Math.round(span / 34));
  let d = `M ${x1.toFixed(1)} ${(y + (rng() - 0.5) * amp).toFixed(1)}`;
  for (let i = 1; i <= steps; i++) {
    const x = x1 + (span * i) / steps;
    const yy = y + (rng() - 0.5) * amp;
    d += ` L ${x.toFixed(1)} ${yy.toFixed(1)}`;
  }
  return d;
}

/** A denser back-and-forth squiggle for the scribble underline. */
function scribblePath(x1: number, x2: number, y: number, amp: number, rng: () => number) {
  const span = x2 - x1;
  const steps = Math.max(6, Math.round(span / 12));
  let d = `M ${x1.toFixed(1)} ${y.toFixed(1)}`;
  for (let i = 1; i <= steps; i++) {
    const x = x1 + (span * i) / steps;
    const dir = i % 2 === 0 ? -1 : 1;
    const yy = y + dir * amp * (0.6 + rng() * 0.4);
    const cx = x - span / steps / 2 + (rng() - 0.5) * 4;
    const cy = y + dir * -amp * (0.4 + rng() * 0.5);
    d += ` Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${x.toFixed(1)} ${yy.toFixed(1)}`;
  }
  return d;
}

/**
 * A hand-drawn loop around the text. A pen does not close a circle exactly:
 * the stroke starts at the upper left, runs a little past a full turn, and
 * drifts outward as it goes, so the end overlaps the start just off-line.
 * Points are joined with a Catmull-Rom spline, so the loop stays smooth.
 */
function circlePath(cx: number, cy: number, rx: number, ry: number, rng: () => number) {
  const turns = 1.06 + rng() * 0.06;
  const start = -Math.PI * 0.62 + (rng() - 0.5) * 0.4;
  const phase = rng() * Math.PI * 2;
  const count = 28;
  const points: Array<[number, number]> = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const a = start + t * turns * Math.PI * 2;
    const drift = 1 + (t - 0.5) * 0.08;
    const wobble = 1 + Math.sin(a * 2 + phase) * 0.025 + (rng() - 0.5) * 0.015;
    points.push([cx + Math.cos(a) * rx * drift * wobble, cy + Math.sin(a) * ry * drift * wobble]);
  }
  let d = `M ${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

/** The most a circle pass can pull inward: outward drift and wobble at their lowest. */
const CIRCLE_MIN_REACH = 0.92;

/**
 * An ellipse that encloses every line of the text, not just its bounding box.
 * An ellipse narrows toward its ends, so half-extents plus padding leave the
 * corners of the outer lines outside it and the stroke cuts through words.
 *
 * Each line box is trimmed to roughly where the glyphs sit (the content box
 * includes empty space above caps and below descenders). The shape follows
 * the block: a single wide line gets a flat ellipse that hugs it horizontally,
 * a tall block of wrapped lines a rounder one. It is then scaled so the
 * farthest line corner sits on it, and widened by the wobble margin so no
 * hand-drawn pass can dip into the text.
 */
function fitEllipse(lineRects: DOMRect[], hostBox: DOMRect, padding: number) {
  const boxes = lineRects.map((r) => {
    const trim = r.height * 0.12;
    return {
      left: r.left - hostBox.left,
      right: r.right - hostBox.left,
      top: r.top - hostBox.top + trim,
      bottom: r.bottom - hostBox.top - trim,
    };
  });
  const left = Math.min(...boxes.map((b) => b.left));
  const right = Math.max(...boxes.map((b) => b.right));
  const top = Math.min(...boxes.map((b) => b.top));
  const bottom = Math.max(...boxes.map((b) => b.bottom));
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const halfW = Math.max(1, (right - left) / 2);
  const halfH = Math.max(1, (bottom - top) / 2);

  // Stretch factors with 1/fx^2 + 1/fy^2 = 1, so the bounding box corners land
  // exactly on the ellipse. Equal factors (sqrt 2) are the roundest fit; wide
  // lines lean on fy instead, so the loop does not reach far into the words on
  // either side.
  const wide = Math.min(1, Math.max(0, (halfW / halfH - 1.5) / 4));
  const fx = Math.SQRT2 - wide * (Math.SQRT2 - 1.15);
  const fy = 1 / Math.sqrt(1 - 1 / (fx * fx));
  let rx = halfW * fx;
  let ry = halfH * fy;

  // Wrapped lines rarely fill the bounding box corners (a short last line),
  // so shrink to the farthest real corner when that is tighter.
  let reach = 0;
  for (const b of boxes) {
    for (const x of [b.left, b.right]) {
      for (const y of [b.top, b.bottom]) {
        reach = Math.max(reach, Math.hypot((x - cx) / rx, (y - cy) / ry));
      }
    }
  }
  rx = (rx * reach) / CIRCLE_MIN_REACH + padding;
  ry = (ry * reach) / CIRCLE_MIN_REACH + padding;
  return { cx, cy, rx, ry };
}

/**
 * A hand-drawn box: four slightly bowed sides with loose corners, drawn in
 * one stroke that runs past the first corner when it comes back round.
 */
function boxPath(x1: number, y1: number, x2: number, y2: number, rng: () => number) {
  const j = () => (rng() - 0.5) * 3;
  const tl: [number, number] = [x1 + j(), y1 + j()];
  const tr: [number, number] = [x2 + j(), y1 + j()];
  const br: [number, number] = [x2 + j(), y2 + j()];
  const bl: [number, number] = [x1 + j(), y2 + j()];
  const end: [number, number] = [x1 + Math.min(14, (x2 - x1) * 0.12), y1 + j()];
  const side = (a: [number, number], b: [number, number]) => {
    const bow = (rng() - 0.5) * 3;
    const mx = (a[0] + b[0]) / 2 + (b[1] - a[1] === 0 ? 0 : bow);
    const my = (a[1] + b[1]) / 2 + (b[0] - a[0] === 0 ? 0 : bow);
    return ` Q ${mx.toFixed(1)} ${my.toFixed(1)} ${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
  };
  const start: [number, number] = [x1 - 3 + j(), tl[1]];
  return (
    `M ${start[0].toFixed(1)} ${start[1].toFixed(1)}` +
    side(start, tr) +
    side(tr, br) +
    side(br, bl) +
    side(bl, tl) +
    side(tl, end)
  );
}

function marksEqual(a: Mark[], b: Mark[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].d !== b[i].d || a[i].delay !== b[i].delay) return false;
  }
  return true;
}

/**
 * TextScribble
 *
 * Hand-drawn annotations for React text that draw themselves on: scribble,
 * underline, strike-through, or a circle or box around the words. Lines track
 * wrapping per line; circle and box wrap the whole phrase. Re-fits on resize
 * and font load.
 *
 * Motion contract:
 * - Measures the live text via Range client rects (ResizeObserver, no polling).
 * - Marks paint client-side only (no SSR path → no hydration diff).
 * - Each stroke reveals via a single `stroke-dashoffset` transition
 *   (pathLength normalised to 100).
 * - `trigger="view"` draws once on-screen; `"hover"` draws and retracts.
 * - Honours `prefers-reduced-motion` by drawing instantly, no transition.
 */
export function TextScribble({
  children,
  type = "scribble",
  color,
  strokeWidth = 2,
  duration = 0.9,
  delay = 0,
  trigger = "view",
  iterations,
  padding = 2,
  drawn,
  as = "span",
  className,
  "aria-label": ariaLabel,
}: TextScribbleProps) {
  const hostRef = React.useRef<HTMLElement | null>(null);
  const textRef = React.useRef<HTMLSpanElement | null>(null);

  const [size, setSize] = React.useState({ w: 0, h: 0 });
  const [marks, setMarks] = React.useState<Mark[]>([]);
  const [active, setActive] = React.useState(trigger === "mount");
  const [reduceMotion, setReduceMotion] = React.useState(false);

  const stroke = color ?? DEFAULT_COLOR;
  const passes = Math.max(1, Math.min(4, iterations ?? (type === "scribble" ? 2 : 1)));

  // --- Measure text geometry into annotation paths -------------------------
  const measure = React.useCallback(() => {
    const host = hostRef.current;
    const text = textRef.current;
    if (!host || !text || !text.firstChild) return;

    const hostBox = host.getBoundingClientRect();
    if (hostBox.width < 1) return;

    const range = document.createRange();
    range.selectNodeContents(text);
    const lineRects = Array.from(range.getClientRects()).filter((r) => r.width > 1);
    if (lineRects.length === 0) return;

    const next: Mark[] = [];
    const stagger = lineRects.length > 1 ? duration * 0.3 : duration * 0.12;

    // Circle and box wrap the whole phrase, across every wrapped line.
    if (type === "circle" || type === "box") {
      const left = Math.min(...lineRects.map((r) => r.left)) - hostBox.left;
      const right = Math.max(...lineRects.map((r) => r.right)) - hostBox.left;
      const top = Math.min(...lineRects.map((r) => r.top)) - hostBox.top;
      const bottom = Math.max(...lineRects.map((r) => r.bottom)) - hostBox.top;
      const lineHeight = Math.min(...lineRects.map((r) => r.height));
      const circle = type === "circle" ? fitEllipse(lineRects, hostBox, padding) : null;
      for (let p = 0; p < passes; p++) {
        const rng = mulberry32(4243 + p * 97 + Math.round(right - left));
        const d = circle
          ? circlePath(circle.cx, circle.cy, circle.rx, circle.ry, rng)
          : boxPath(
              left - padding - lineHeight * 0.18,
              top - padding * 0.5,
              right + padding + lineHeight * 0.18,
              bottom + padding * 0.5,
              rng,
            );
        next.push({ d, delay: delay + p * duration * 0.35 });
      }
    }

    if (type !== "circle" && type !== "box") lineRects.forEach((r, lineIdx) => {
      const x = r.left - hostBox.left;
      const y = r.top - hostBox.top;
      const baseY = type === "strike-through" ? y + r.height * 0.55 : y + r.height - strokeWidth;

      for (let p = 0; p < passes; p++) {
        const rng = mulberry32(7919 + lineIdx * 131 + p * 53 + Math.round(r.width));
        const d =
          type === "scribble"
            ? scribblePath(x - padding, x + r.width + padding, baseY, Math.min(r.height * 0.16, 5) + strokeWidth, rng)
            : jitterLine(x - padding, x + r.width + padding, baseY, 1.6, rng);
        next.push({ d, delay: delay + (lineIdx * passes + p) * (stagger / passes) });
      }
    });

    setSize((prev) =>
      prev.w === hostBox.width && prev.h === hostBox.height
        ? prev
        : { w: hostBox.width, h: hostBox.height },
    );
    setMarks((prev) => (marksEqual(prev, next) ? prev : next));
  }, [type, strokeWidth, passes, padding, delay, duration]);

  React.useLayoutEffect(() => {
    let cancelled = false;
    const run = () => {
      if (!cancelled) measure();
    };

    run();
    const host = hostRef.current;
    if (!host) return;

    const ro = new ResizeObserver(run);
    ro.observe(host);

    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    fonts?.ready?.then(run).catch(() => {});

    return () => {
      cancelled = true;
      ro.disconnect();
    };
  }, [measure, children]);

  // --- Reduced motion ------------------------------------------------------
  React.useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduceMotion(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // --- Trigger -------------------------------------------------------------
  React.useEffect(() => {
    if (drawn !== undefined) {
      setActive(drawn);
      return;
    }
    if (trigger === "mount") {
      setActive(true);
      return;
    }
    if (trigger === "view") {
      const host = hostRef.current;
      if (!host) return;
      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            setActive(true);
            io.disconnect();
          }
        },
        { threshold: 0.35 },
      );
      io.observe(host);
      return () => io.disconnect();
    }
  }, [trigger, drawn]);

  const isHover = trigger === "hover" && drawn === undefined;
  const hoverProps = isHover
    ? {
        tabIndex: 0 as const,
        onPointerEnter: () => setActive(true),
        onPointerLeave: () => setActive(false),
        onFocus: () => setActive(true),
        onBlur: () => setActive(false),
      }
    : {};

  const Tag = as as unknown as React.ComponentType<
    React.HTMLAttributes<HTMLElement> & { ref?: React.RefCallback<HTMLElement | null> }
  >;

  const show = active || reduceMotion;
  const ease = "cubic-bezier(.65,0,.35,1)";

  return (
    <Tag
      ref={(node) => {
        hostRef.current = node;
      }}
      aria-label={ariaLabel}
      className={cn("relative inline-block", className)}
      {...hoverProps}
    >
      <span ref={textRef} className="relative z-[1]">
        {children}
      </span>
      {size.w > 0 && marks.length > 0 ? (
        <svg
          width={size.w}
          height={size.h}
          viewBox={`0 0 ${size.w} ${size.h}`}
          fill="none"
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 z-[1] overflow-visible"
        >
          {marks.map((m, i) => (
            <path
              key={i}
              d={m.d}
              stroke={stroke}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
              pathLength={100}
              style={{
                strokeDasharray: 100,
                strokeDashoffset: show ? 0 : 100,
                transition: reduceMotion
                  ? "none"
                  : `stroke-dashoffset ${duration}s ${ease} ${m.delay}s`,
              }}
            />
          ))}
        </svg>
      ) : null}
    </Tag>
  );
}
