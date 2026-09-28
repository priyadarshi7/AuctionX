import type { AuctionStatus } from '@/lib/types/auction';
import type { OrderStatus } from '@/lib/types/order';

const AUCTION: Record<AuctionStatus, { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: 'bg-cream-2' },
  PUBLISHED: { label: 'Scheduled', cls: 'bg-cyan' },
  ACTIVE: { label: 'Live', cls: 'bg-green' },
  PAUSED: { label: 'Paused', cls: 'bg-yellow' },
  ENDED: { label: 'Ended', cls: 'bg-ink text-cream' },
  CANCELLED: { label: 'Cancelled', cls: 'bg-white' },
};

const ORDER: Record<OrderStatus, { label: string; cls: string }> = {
  PENDING_PAYMENT: { label: 'Awaiting payment', cls: 'bg-yellow' },
  PAID: { label: 'Paid', cls: 'bg-green' },
  CANCELLED: { label: 'Cancelled', cls: 'bg-white' },
};

function Pill({ label, cls }: { label: string; cls: string }) {
  return (
    <span className={`inline-flex items-center rounded-full border-2 border-ink px-2.5 py-0.5 text-xs font-semibold ${cls}`}>
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
