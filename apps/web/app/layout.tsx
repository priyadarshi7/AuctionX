import type { Metadata } from "next";
import { Geist, Bricolage_Grotesque, Caveat } from "next/font/google";
import { NavBar } from "./NavBar";
import { Providers } from "./providers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

// Big bold display type for headlines/logo — the "PRODUCT INTERFACES" /
// "PANKAJ" scale type in the reference design. Not used for body copy.
const bricolage = Bricolage_Grotesque({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "700", "800"],
});

// Handwritten accent font for sticky-note style annotations only — never
// body copy or anything that needs to stay easily legible/accessible.
const caveat = Caveat({
  variable: "--font-hand",
  subsets: ["latin"],
  weight: ["500", "700"],
});

export const metadata: Metadata = {
  title: "AuctionX",
  description: "AI-powered auction platform",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${bricolage.variable} ${caveat.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-cream text-ink">
        <Providers>
          <NavBar />
          {children}
        </Providers>
      </body>
    </html>
  );
}
