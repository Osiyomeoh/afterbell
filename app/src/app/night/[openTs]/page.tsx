import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";

import { ShareButtons } from "@/components/ShareButtons";
import { usd } from "@/lib/format";
import { nightHeadline, nightShareText, nightSummary } from "@/lib/night";
import { nightView } from "@/server/night";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ openTs: string }> };

const view = cache((openTs: string) => nightView(openTs).catch(() => null));
const read = async (params: Props["params"]) => view((await params).openTs);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const n = await read(params);
  if (!n) return { title: "Night not found" };
  // The image comes from opengraph-image.tsx beside this page.
  return { title: nightHeadline(n), description: nightSummary(n), twitter: { card: "summary_large_image" } };
}

/** One night of the record, to share: what was covered and what the bell paid. */
export default async function NightPage({ params }: Props) {
  const n = await read(params);
  if (!n) notFound();
  const facts: [string, string][] = [
    ["Open", n.day],
    ["Stocks", n.symbols.join(", ")],
    ["Positions", String(n.positions)],
    ["Premiums", usd(n.premiums)],
    ["Paid out", usd(n.paid)],
  ];

  return (
    <section className="mx-auto max-w-3xl py-10 sm:py-14">
      <p className="text-xs font-medium tracking-wide text-brass uppercase">Afterbell record · both chains</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{nightHeadline(n)}</h1>
      <p className="mt-3 leading-relaxed text-muted">{nightSummary(n)}.</p>
      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-[repeat(3,max-content)] sm:gap-x-10">
        {facts.map(([k, val]) => (
          <div key={k} className="min-w-0">
            <dt className="text-xs text-faint">{k}</dt>
            <dd className="num">{val}</dd>
          </div>
        ))}
      </dl>
      <ShareButtons text={nightShareText(n)} />
      <p className="mt-6 text-sm">
        <Link href="/verify" className="text-brass hover:underline">
          Check every payout →
        </Link>
      </p>
      <p className="mt-6 text-xs leading-relaxed text-faint">Test money only: TestUSD has no value. The opening prices are the oracle&apos;s real ones.</p>
    </section>
  );
}
