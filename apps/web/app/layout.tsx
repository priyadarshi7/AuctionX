import type { Metadata } from "next";
import { Geist, Geist_Mono, Newsreader } from "next/font/google";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import { NavBar } from "./NavBar";
import { Providers } from "./providers";
import { VerificationBanner } from "./components/VerificationBanner";
import { TestModeBanner } from "./components/TestModeBanner";
import { Colophon } from "./components/Colophon";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

// Headings, lot titles, prices and clocks. `opsz` lets one family look right
// from 12px captions to 60px headlines.
const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  style: ["normal", "italic"],
  axes: ["opsz"],
});

// Reference codes and keyboard hints.
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AuctionX",
  description: "AI-powered auction platform",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${geistMono.variable} ${newsreader.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="flex min-h-full flex-col">
        <Providers>
          <TestModeBanner />
          <NavBar />
          <VerificationBanner />
          {children}
          <Colophon />
        </Providers>
      </body>
    </html>
  );
}
