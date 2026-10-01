import type { Metadata } from "next";

import { GapReport } from "@/components/GapReport";

export const metadata: Metadata = {
  title: "Gap report",
  description: "What the hours the exchange is shut could cost a book of tokenized stocks, and what protecting it until the next open costs now.",
};

export default function Page() {
  return (
    <>
      <section className="py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Gap report</h1>
        <p className="mt-3 max-w-2xl leading-relaxed text-muted">
          For a wallet, a vault or a lending market&apos;s collateral: how each stock has opened after its closes, what its worst opening would cost
          the book at today&apos;s price, and what protecting it until the next open costs now. It reads prices only; nothing is bought here.
        </p>
      </section>
      <GapReport />
    </>
  );
}
