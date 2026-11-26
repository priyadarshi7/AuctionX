import { isOptimisticBid } from '@/lib/bids';
import { formatCents } from '@/lib/format';
import type { Bid } from '@/lib/types/auction';

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

function Tag({ children, solid = false }: { children: React.ReactNode; solid?: boolean }) {
  return (
    <span
      className={`border px-1.5 py-0.5 text-[10px] font-medium uppercase leading-none tracking-[0.12em] ${
        solid ? 'border-accent bg-accent text-accent-ink' : 'border-border-strong'
      }`}
    >
      {children}
    </span>
  );
}

// The bid history set as a ledger: when, who (only ever "you" — other
// bidders stay anonymous), how much it raised the price, and the new price.
export function BidLedger({
  bids,
  startingPriceCents,
  userId,
  leadingBidId,
}: {
  bids: Bid[];
  startingPriceCents: number;
  userId: string | undefined;
  leadingBidId: string | undefined;
}) {
  // A raise is measured against the next-lower accepted amount. The oldest
  // bid on screen may have older ones the page didn't fetch, so it only gets
  // a raise figure when the history is short enough to be complete.
  const amounts = bids.map((bid) => bid.amountCents).sort((a, b) => a - b);
  const complete = bids.length < 20;
  const raiseFor = (amount: number): number | null => {
    const i = amounts.indexOf(amount);
    if (i > 0) return amount - amounts[i - 1]!;
    return complete ? amount - startingPriceCents : null;
  };

  return (
    <section aria-labelledby="bids-heading">
      <div className="flex items-baseline justify-between border-b-2 border-foreground pb-2">
        <h2 id="bids-heading" className="text-2xl font-medium">
          Bid ledger
        </h2>
        <span className="eyebrow">
          {bids.length}
          {complete ? '' : '+'} {bids.length === 1 ? 'bid' : 'bids'}
        </span>
      </div>

      {bids.length === 0 ? (
        <p className="border-b border-border py-8 text-center font-serif text-lg italic text-muted-foreground">
          No bids yet. The first one opens the lot.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead className="sr-only">
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Raised by</th>
              <th scope="col">Bid</th>
            </tr>
          </thead>
          <tbody>
            {bids.map((bid) => {
              const pending = isOptimisticBid(bid);
              const isLeader = bid.id === leadingBidId && !pending;
              const mine = !!userId && bid.bidderId === userId;
              const raise = raiseFor(bid.amountCents);
              const at = new Date(bid.createdAt);
              return (
                <tr key={bid.id} className={`border-b border-border ${isLeader ? 'bg-accent-soft' : ''}`}>
                  <td className="py-3 pl-1 pr-3">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-mono text-xs text-muted-foreground">
                        {day.format(at)} {time.format(at)}
                      </span>
                      {isLeader && <Tag solid>Leading</Tag>}
                      {mine && <Tag>You</Tag>}
                      {pending && (
                        <span className="animate-pulse">
                          <Tag>Placing…</Tag>
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="py-3 pr-3 text-right font-mono text-xs text-muted-foreground">
                    {raise !== null && raise > 0 ? `+${formatCents(raise)}` : ''}
                  </td>
                  <td
                    className={`figures py-3 pr-1 text-right text-lg ${isLeader ? '' : 'text-muted-foreground'}`}
                  >
                    {formatCents(bid.amountCents)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
