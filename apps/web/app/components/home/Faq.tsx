const QUESTIONS = [
  {
    q: 'What is anti-sniping?',
    a: 'If a valid bid arrives in the last 30 seconds, the auction extends by 30 seconds. The server decides this, not your browser clock, so nobody wins by out-timing everyone else.',
  },
  {
    q: 'How do I know if I’ve been outbid?',
    a: 'You get an in-app notification right away, and the bell in the header shows an unread count. The auction page also updates live while you watch it.',
  },
  {
    q: 'What happens when I win?',
    a: 'When the auction closes, the highest valid bid wins and an order is created. Pay for it from your Orders page. Treat every bid as a commitment.',
  },
  {
    q: 'Can I trust the price I see?',
    a: 'Prices come from the server. Your bid is validated against the current price when it arrives, so a stale screen can never place a bid the auction wouldn’t accept.',
  },
];

// Native <details>: keyboard and screen-reader accessible with zero JS.
export function Faq() {
  return (
    <section className="mx-auto max-w-3xl px-6 pb-16">
      <h2 className="mb-6 font-display text-3xl font-extrabold sm:text-4xl">Good questions</h2>
      <div className="flex flex-col gap-3">
        {QUESTIONS.map((item) => (
          <details key={item.q} className="faq rounded-2xl border-2 border-ink bg-white shadow-hard-sm open:bg-cream-2">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-2xl px-5 py-4 font-display text-lg font-bold">
              {item.q}
              <span
                aria-hidden
                className="faq-icon flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-ink bg-yellow text-base leading-none"
              >
                +
              </span>
            </summary>
            <p className="px-5 pb-4 text-ink/70">{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
