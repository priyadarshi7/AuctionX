'use client';

import Link from 'next/link';
import { useState } from 'react';

type Role = 'buy' | 'sell';

const STEPS: Record<Role, { title: string; body: string }[]> = {
  buy: [
    {
      title: 'Find something you want',
      body: 'Browse live auctions by category. Every card shows the current bid and the time left.',
    },
    {
      title: 'Bid in real time',
      body: 'The server checks your bid against the true current price. Watchers see it the instant it lands, no refresh.',
    },
    {
      title: 'Win and pay',
      body: 'When the clock ends, the highest valid bid wins and an order is created for you to pay from your Orders page.',
    },
  ],
  sell: [
    {
      title: 'List it',
      body: 'Add photos, a description, the condition and a starting price. Keep it as a draft while you polish.',
    },
    {
      title: 'Go live',
      body: 'Pick a duration and publish. A bid in the last seconds extends the clock, so late bidders can’t snipe.',
    },
    {
      title: 'Get notified',
      body: 'Outbid, won or sold: alerts land in-app the moment it happens. Track it all from My auctions.',
    },
  ],
};

export function HowItWorks({ signedIn }: { signedIn: boolean }) {
  const [role, setRole] = useState<Role>('buy');
  const steps = STEPS[role];

  return (
    <section className="mx-auto max-w-6xl px-6 py-16">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <h2 className="font-display text-3xl font-extrabold sm:text-4xl">How it works</h2>
        <div role="tablist" aria-label="How it works for" className="flex rounded-full border-2 border-line bg-white p-1">
          {(['buy', 'sell'] as const).map((r) => (
            <button
              key={r}
              type="button"
              role="tab"
              id={`hiw-tab-${r}`}
              aria-selected={role === r}
              aria-controls="hiw-panel"
              onClick={() => setRole(r)}
              className={`rounded-full px-5 py-1.5 text-sm font-semibold transition-colors ${
                role === r ? 'bg-yellow text-ink' : 'text-ink/70 hover:bg-cream-2'
              }`}
            >
              {r === 'buy' ? 'I want to bid' : 'I want to sell'}
            </button>
          ))}
        </div>
      </div>

      <div
        id="hiw-panel"
        role="tabpanel"
        aria-labelledby={`hiw-tab-${role}`}
        className="grid grid-cols-1 gap-4 sm:grid-cols-3"
      >
        {steps.map((step, i) => (
          <div
            key={`${role}-${i}`}
            className="step-in rounded-2xl border-2 border-line bg-white p-5 shadow-hard-sm"
            style={{ animationDelay: `${i * 80}ms` }}
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-line bg-cyan font-display font-extrabold">
              {i + 1}
            </span>
            <p className="mt-3 font-display text-lg font-bold">{step.title}</p>
            <p className="mt-1 text-sm text-ink/70">{step.body}</p>
          </div>
        ))}
      </div>

      <div className="mt-6">
        <Link
          href={role === 'buy' ? '/auctions' : signedIn ? '/auctions/new' : '/register'}
          className="inline-block rounded-full border-2 border-line bg-yellow px-6 py-2.5 font-display font-bold shadow-hard-sm transition-transform hover:-translate-y-0.5"
        >
          {role === 'buy' ? 'Start browsing' : signedIn ? 'List an item' : 'Create an account to sell'}
        </Link>
      </div>
    </section>
  );
}
