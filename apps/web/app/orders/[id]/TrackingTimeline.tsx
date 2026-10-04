import type { Order, ShipmentEventType } from '@/lib/types/order';

const TITLE: Record<ShipmentEventType, string> = {
  LABEL_CREATED: 'Label created',
  IN_TRANSIT: 'In transit',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
};

// The shipment's own history, newest first, like a courier's tracking page.
// Events come from the platform's shipping provider (ADR-0045); with the demo
// courier they are simulated, which the carrier name says.
export function TrackingTimeline({ order }: { order: Order }) {
  const events = [...(order.shipmentEvents ?? [])].reverse();
  if (events.length === 0) return null;

  return (
    <section aria-labelledby="tracking-heading" className="rounded-2xl border-2 border-line bg-white p-6">
      <h2 id="tracking-heading" className="font-display text-xl font-extrabold">
        Tracking
      </h2>
      <p className="mb-4 mt-1 text-sm text-ink/70">
        {order.carrier} · <span className="font-mono">{order.trackingNumber}</span>
      </p>
      <ol className="flex flex-col">
        {events.map((event, i) => (
          <li key={event.id} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span aria-hidden className={`mt-1 h-3 w-3 shrink-0 rounded-full border-2 border-line ${i === 0 ? 'bg-green' : 'bg-white'}`} />
              {i < events.length - 1 && <span aria-hidden className="w-0.5 grow bg-line/30" />}
            </div>
            <div className="pb-4">
              <p className="font-semibold">{TITLE[event.type]}</p>
              <p className="text-sm text-ink/70">
                {event.description}
                {event.location ? ` · ${event.location}` : ''}
              </p>
              <time className="text-xs text-ink/50" dateTime={event.occurredAt}>
                {new Date(event.occurredAt).toLocaleString()}
              </time>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
