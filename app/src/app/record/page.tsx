import type { Metadata } from "next";

import { TrackRecord } from "@/components/TrackRecord";

export const metadata: Metadata = { title: "Track record" };

export default function Page() {
  return (
    <>
      <section className="py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Track record</h1>
        <p className="mt-3 max-w-2xl leading-relaxed text-muted">
          Two records: what the vaults have actually sold and settled, and the same pricing replayed on every recorded TSLA opening.
        </p>
      </section>
      <TrackRecord />
    </>
  );
}
