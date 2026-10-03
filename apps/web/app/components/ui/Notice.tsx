import type { ReactNode } from 'react';

type Tone = 'error' | 'success' | 'info';

const TONES: Record<Tone, { chip: string; icon: string; role: 'alert' | 'status' }> = {
  error: { chip: 'bg-pink', icon: '!', role: 'alert' },
  success: { chip: 'bg-green', icon: '✓', role: 'status' },
  info: { chip: 'bg-cyan', icon: 'i', role: 'status' },
};

// Inline message block. The chip colour reinforces, but the icon glyph and
// the text always say what it is, so it reads without colour.
export function Notice({ tone = 'info', children }: { tone?: Tone; children: ReactNode }) {
  const t = TONES[tone];
  return (
    <div role={t.role} className="flex items-start gap-3 rounded-xl border-2 border-line bg-white p-3 text-sm shadow-hard-sm">
      <span
        aria-hidden
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-line text-[11px] font-extrabold leading-none ${t.chip}`}
      >
        {t.icon}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
