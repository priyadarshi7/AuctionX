'use client';

import { Tabs, TabsList, TabsTrigger } from '@/components/wensity/tabs';
import { ButtonLink } from '../ui/Button';

export type Role = 'buy' | 'sell';

const CLAUSES: Record<Role, { title: string; body: string }[]> = {
  buy: [
    {
      title: 'Choose a lot',
      body: 'Read the catalogue by department. Every lot shows the standing bid and the time left.',
    },
    {
      title: 'Bid in real time',
      body: 'The server checks your bid against the true current price. Watchers see it the moment it lands, with no refresh.',
    },
    {
      title: 'The late-bid rule',
      body: 'A valid bid in the last 30 seconds extends the auction by 30 seconds, so nobody wins by sniping.',
    },
    {
      title: 'Win and pay',
      body: 'When the clock ends, the highest valid bid wins and an order is created for you to pay from your Orders page.',
    },
  ],
  sell: [
    {
      title: 'List it',
      body: 'Add photos, a description and the condition. Keep it as a draft while you polish.',
    },
    {
      title: 'Set the price',
      body: 'An AI estimate can inform your starting price. The decision stays yours.',
    },
    {
      title: 'Review, then sale',
      body: 'The listing is reviewed before it goes live. Late bids extend the clock.',
    },
    {
      title: 'Follow the hammer',
      body: 'Outbid, won or sold: alerts arrive in the app. Track everything from My auctions.',
    },
  ],
};

const NUMERALS = ['i.', 'ii.', 'iii.', 'iv.'];

export function HowItWorks({
  signedIn,
  role,
  onRoleChange: setRole,
}: {
  signedIn: boolean;
  role: Role;
  onRoleChange: (role: Role) => void;
}) {
  return (
    <section id="conditions" className="mx-auto max-w-6xl scroll-mt-24 px-4 py-14 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-foreground pb-4">
        <h2 className="text-3xl font-medium tracking-tight">Conditions of sale</h2>
        <Tabs variant="segmented" value={role} onValueChange={(next) => setRole(next as Role)}>
          <TabsList aria-label="Conditions for">
            <TabsTrigger value="buy">For bidders</TabsTrigger>
            <TabsTrigger value="sell">For sellers</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <ol aria-live="polite" className="grid gap-x-14 md:grid-cols-2">
        {CLAUSES[role].map((clause, i) => (
          <li key={`${role}-${clause.title}`} className="flex gap-5 border-b border-border py-6">
            <span aria-hidden className="w-8 shrink-0 font-serif text-2xl italic leading-none text-accent">
              {NUMERALS[i]}
            </span>
            <div>
              <h3 className="text-xl font-medium leading-none">{clause.title}</h3>
              <p className="mt-2.5 text-sm leading-6 text-muted-foreground">{clause.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-6">
        <ButtonLink
          href={role === 'buy' ? '/auctions' : signedIn ? '/auctions/new' : '/register'}
          variant="secondary"
          size="sm"
        >
          {role === 'buy' ? 'Read the catalogue' : signedIn ? 'Sell an item' : 'Create an account to sell'}
        </ButtonLink>
      </div>
    </section>
  );
}
