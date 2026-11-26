import Link from 'next/link';

// The closing line of every page, as a printed catalogue ends.
export function Colophon() {
  return (
    <footer className="mx-auto mt-10 w-full max-w-6xl px-4 pb-10 sm:px-6">
      <div aria-hidden className="rule-double" />
      <div className="flex flex-wrap items-baseline justify-between gap-3 pt-4">
        <p className="font-serif text-lg">
          Auction<span className="italic text-accent">X</span>
          <span className="ml-3 text-sm italic text-muted-foreground">
            A demonstration saleroom. Prices and results come from the server.
          </span>
        </p>
        <Link href="/auctions" className="eyebrow hover:text-foreground">
          Catalogue
        </Link>
      </div>
    </footer>
  );
}
