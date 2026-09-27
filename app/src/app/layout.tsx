import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";

import "./globals.css";
import { Providers } from "./providers";

const sans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const mono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

const description =
  "Protection for tokenized stocks until the next opening bell. Pay once; if the stock opens below your level, the vault pays the difference. Settled on-chain by the first oracle print after 09:30 ET.";

export const metadata: Metadata = {
  // The hosted address (SITE_URL, read at build time), so link previews point at the app's own image rather than localhost.
  ...(process.env.SITE_URL && { metadataBase: new URL(process.env.SITE_URL) }),
  title: { default: "Afterbell · Protection until the opening bell", template: "%s · Afterbell" },
  description,
};

export const viewport: Viewport = { themeColor: "#0b0d10", colorScheme: "dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} antialiased`}>
      <body className="min-h-screen font-sans">
        <Providers>
          <Header />
          <main className="mx-auto w-full max-w-7xl px-4 pb-24 sm:px-6">{children}</main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
