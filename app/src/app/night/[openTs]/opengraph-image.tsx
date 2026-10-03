import { ImageResponse } from "next/og";

import { nightHeadline, nightSummary } from "@/lib/night";
import { nightView } from "@/server/night";

export const alt = "One night of Afterbell's record: what was covered and what the bell paid";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#0b0d10";
const TEXT = "#ebe8e1";
const MUTED = "#9aa1a9";
const BRASS = "#d9a441";
const GAIN = "#6fcf97";

/** The card X and Telegram show for a night's share page. */
export default async function Image({ params }: { params: Promise<{ openTs: string }> }) {
  const { openTs } = await params;
  const n = await nightView(openTs).catch(() => null);
  const lines = n ? [nightSummary(n), "Every payout recomputed from the chain at /verify"] : ["Protection for tokenized stocks until the next opening bell."];

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: INK, color: TEXT, padding: 72, fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 40, fontWeight: 600 }}>
            <svg width="50" height="50" viewBox="0 0 24 24" fill="none">
              <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z" stroke={BRASS} strokeWidth="1.8" strokeLinejoin="round" />
              <path d="M10 20.5a2 2 0 0 0 4 0" stroke={BRASS} strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            Afterbell
          </div>
          {n && <div style={{ fontSize: 30, color: BRASS }}>The record</div>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
          <div style={{ fontSize: 64, fontWeight: 600, lineHeight: 1.12, maxWidth: 1050, color: n && n.paid > 0 ? GAIN : TEXT }}>{n ? nightHeadline(n) : "Afterbell"}</div>
          {lines.map((l) => (
            <div key={l} style={{ fontSize: 30, color: MUTED }}>
              {l}
            </div>
          ))}
        </div>
        <div style={{ fontSize: 26, color: MUTED }}>Test money, real oracle.</div>
      </div>
    ),
    size,
  );
}
