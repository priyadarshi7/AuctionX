import type { AuctionStatus } from '@/lib/types/auction';
import type { OrderStatus } from '@/lib/types/order';
import type { ValuationStatus } from '@/lib/types/valuation';

type Tone = 'neutral' | 'live' | 'accent' | 'muted';

const DOT: Record<Tone, string> = {
  neutral: 'bg-foreground/50',
  live: 'bg-live',
  accent: 'bg-accent',
  muted: 'bg-muted-foreground/40',
};

type Meta = { label: string; tone: Tone };

const AUCTION: Record<AuctionStatus, Meta> = {
  DRAFT: { label: 'Draft', tone: 'muted' },
  PENDING_REVIEW: { label: 'In review', tone: 'accent' },
  PUBLISHED: { label: 'Scheduled', tone: 'neutral' },
  ACTIVE: { label: 'Live', tone: 'live' },
  PAUSED: { label: 'Paused', tone: 'accent' },
  ENDED: { label: 'Ended', tone: 'neutral' },
  CANCELLED: { label: 'Cancelled', tone: 'muted' },
};

const ORDER: Record<OrderStatus, Meta> = {
  PENDING_PAYMENT: { label: 'Awaiting payment', tone: 'accent' },
  PAID: { label: 'Paid', tone: 'live' },
  SHIPPED: { label: 'Shipped', tone: 'neutral' },
  DELIVERED: { label: 'Delivered', tone: 'live' },
  CANCELLED: { label: 'Cancelled', tone: 'muted' },
};

// FAILED stays neutral on purpose: ValuationPanel pairs it with an error
// Notice that carries the actual message.
const VALUATION: Record<ValuationStatus, Meta> = {
  PENDING: { label: 'Analyzing…', tone: 'accent' },
  COMPLETE: { label: 'Ready', tone: 'live' },
  FAILED: { label: 'Failed', tone: 'muted' },
};

// Dot + word: the status is always readable as text, the dot only helps scan.
function Pill({ label, tone }: Meta) {
  return (
    <span className="inline-flex items-center gap-1.5 border border-border-strong px-2 py-1 text-[10px] font-medium uppercase leading-none tracking-[0.14em]">
      <span aria-hidden className={`size-1.5 rounded-full ${DOT[tone]}`} />
      {label}
    </span>
  );
}

export function AuctionStatusPill({ status }: { status: AuctionStatus }) {
  return <Pill {...AUCTION[status]} />;
}

export function OrderStatusPill({ status }: { status: OrderStatus }) {
  return <Pill {...ORDER[status]} />;
}

export function ValuationStatusPill({ status }: { status: ValuationStatus }) {
  return <Pill {...VALUATION[status]} />;
}
