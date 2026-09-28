import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ShareButtons } from "@/components/ShareButtons";
import { nyTime, usd } from "@/lib/format";
import { headline, outcome, shareText } from "@/lib/share";
import { shareView } from "@/server/share";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ chain: string; id: string }> };

const read = async (params: Props["params"]) => {
  const { chain, id } = await params;
  return shareView(chain, id).catch(() => null);
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const v = await read(params);
  if (!v) return { title: "Protection not found" };
  // The image comes from opengraph-image.tsx beside this page.
  return { title: headline(v), description: outcome(v), twitter: { card: "summary_large_image" } };
}

/** One position, to share: what it protects or how it came out, with its NFT. */
export default async function SharePage({ params }: Props) {
  const v = await read(params);
  if (!v) notFound();
  const chainName = v.chain === "solana" ? "Solana devnet" : "Robinhood Chain";
  const protect = v.chain === "solana" ? `/?symbol=${v.symbol}` : `/?chain=robinhood&symbol=${v.symbol}`;
  const facts: [string, string][] = [
    [v.state === "open" ? "Settles" : "Settled", nyTime(v.openTs)],
    ["Protected", `${usd(v.upper)} → ${usd(v.lower)}`],
    ["Shares", v.shares.toLocaleString("en-US", { maximumFractionDigits: 6 })],
    ["Cost", usd(v.premium)],
    ["Pays up to", usd(v.maxPayout)],
    ...(v.price !== null ? ([["Opening price", usd(v.price)]] as [string, string][]) : []),
    ...(v.payout !== null ? ([[v.state === "voided" ? "Refunded" : "Paid", usd(v.payout)]] as [string, string][]) : []),
  ];

  return (
    <section className="mx-auto max-w-3xl py-10 sm:py-14">
      <div className="grid grid-cols-1 gap-8 sm:grid-cols-[14rem_minmax(0,1fr)] sm:items-start">
        {/* eslint-disable-next-line @next/next/no-img-element -- the NFT's own image, drawn per position */}
        <img src={v.art} alt={`Afterbell protection #${v.number}, ${v.symbol}`} className="w-56 max-w-full rounded-xl border border-line" />
        <div className="min-w-0">
          <p className="text-xs font-medium tracking-wide text-brass uppercase">
            Afterbell protection #{v.number} · {chainName}
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{headline(v)}</h1>
          <p className="mt-3 leading-relaxed text-muted">{outcome(v)}</p>
          <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-[repeat(3,max-content)] sm:gap-x-10">
            {facts.map(([k, val]) => (
              <div key={k} className="min-w-0">
                <dt className="text-xs text-faint">{k}</dt>
                <dd className="num">{val}</dd>
              </div>
            ))}
          </dl>
          <ShareButtons text={shareText(v)} />
          <p className="mt-6 text-sm">
            <Link href={protect} className="text-brass hover:underline">
              Protect your own {v.symbol} →
            </Link>
          </p>
          <p className="mt-6 text-xs leading-relaxed text-faint">
            Test money only: TestUSD has no value. The opening price is the oracle&apos;s real one, and the NFT pays whoever holds it.
          </p>
        </div>
      </div>
    </section>
  );
}
