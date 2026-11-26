import { IconAlertCircle, IconCircleCheck, IconInfoCircle } from '@tabler/icons-react';
import type { ReactNode } from 'react';

type Tone = 'error' | 'success' | 'info';

const TONES = {
  error: { Icon: IconAlertCircle, icon: 'text-urgent', box: 'border-urgent/30 bg-urgent/5', role: 'alert' },
  success: { Icon: IconCircleCheck, icon: 'text-live', box: 'border-live/30 bg-live/5', role: 'status' },
  info: { Icon: IconInfoCircle, icon: 'text-muted-foreground', box: 'border-border bg-surface-muted', role: 'status' },
} as const;

// Inline message block. The icon shape and the text carry the meaning, so it
// reads without relying on colour.
export function Notice({ tone = 'info', children }: { tone?: Tone; children: ReactNode }) {
  const { Icon, icon, box, role } = TONES[tone];
  return (
    <div role={role} className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-sm ${box}`}>
      <Icon aria-hidden className={`mt-px size-4.5 shrink-0 ${icon}`} stroke={1.7} />
      <div className="min-w-0 flex-1 leading-5">{children}</div>
    </div>
  );
}
