import { ImageResponse } from "next/og";

export const alt = "Afterbell: protection for tokenized stocks until the next opening bell";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: "#0b0d10", color: "#ebe8e1", padding: 72, fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20, fontSize: 44, fontWeight: 600 }}>
          <svg width="56" height="56" viewBox="0 0 24 24" fill="none">
            <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z" stroke="#d9a441" strokeWidth="1.8" strokeLinejoin="round" />
            <path d="M10 20.5a2 2 0 0 0 4 0" stroke="#d9a441" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          Afterbell
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ fontSize: 68, fontWeight: 600, lineHeight: 1.1, maxWidth: 960 }}>Protection for your tokenized stock until the next opening bell.</div>
          <div style={{ fontSize: 30, color: "#9aa1a9" }}>Pay once. If it opens below your level, the vault pays the difference. Settled by Pyth.</div>
        </div>
      </div>
    ),
    size,
  );
}
