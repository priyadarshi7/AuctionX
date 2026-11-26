'use client';

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/wensity/accordion';

const QUESTIONS = [
  {
    q: 'How do I know if I’ve been outbid?',
    a: 'You get an in-app notification right away, and the bell in the header shows an unread count. The lot page also updates live while you watch it.',
  },
  {
    q: 'What happens when I win?',
    a: 'When the auction closes, the highest valid bid wins and an order is created. Pay for it from your Orders page. Treat every bid as a commitment.',
  },
  {
    q: 'Can I trust the price I see?',
    a: 'Prices come from the server. Your bid is validated against the current price when it arrives, so a stale screen can never place a bid the auction wouldn’t accept.',
  },
  {
    q: 'Are lots authenticated?',
    a: 'No. Listing details and any supporting documents are reviewed before a lot goes live, but the item itself is not inspected, so this is not a guarantee of authenticity.',
  },
];

export function Faq() {
  return (
    <section className="mx-auto grid max-w-6xl gap-8 px-4 py-14 sm:px-6 lg:grid-cols-[1fr_1.6fr]">
      <div>
        <h2 className="text-3xl font-medium tracking-tight">Notes for bidders</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">Worth reading before your first bid.</p>
      </div>
      <Accordion variant="faq">
        {QUESTIONS.map((item) => (
          <AccordionItem key={item.q} value={item.q}>
            <AccordionTrigger>{item.q}</AccordionTrigger>
            <AccordionContent>{item.a}</AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </section>
  );
}
