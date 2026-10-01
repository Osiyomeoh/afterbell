"use client";

import { useEffect, useRef, useState } from "react";

import { fetchOvernight, type OvernightResponse } from "@/lib/api";
import { nyTime, pct, usd } from "@/lib/format";

const FONT = 12;

/**
 * The stock's price since the last close, on Hyperliquid's perp, which trades
 * while the exchange is shut, drawn against where the protection starts and
 * stops, out to the opening bell that settles it. Updates every minute.
 */
export function OvernightChart(props: { symbol: string; openTs: number; now: number; upper: number; lower: number }) {
  const { symbol, openTs, now, upper, lower } = props;
  const [data, setData] = useState<OvernightResponse | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(560);

  useEffect(() => {
    let live = true;
    const load = () => fetchOvernight(symbol).then((d) => live && setData(d), () => live && setData(null));
    load();
    const t = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [symbol]);

  const ready = !!data && data.symbol === symbol && data.points.length >= 2;

  // Measured once the chart's box exists: before the data arrives there's nothing to measure.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setW(Math.max(240, Math.round(el.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ready]);

  if (!ready) return null;

  const pts = data.points;
  const last = pts[pts.length - 1]!;
  const H = W < 480 ? 170 : 190;
  const pad = { l: 4, r: 4, t: 22, b: 22 };
  const t0 = data.closeTs;
  const t1 = Math.max(openTs, last.t + 60);
  const prices = pts.map((p) => p.price);
  const top = Math.max(...prices, data.close);
  const bottom = Math.min(...prices, upper);
  const margin = Math.max((top - bottom) * 0.3, top * 0.004);
  const hi = top + margin;
  const lo = Math.max(bottom - margin, 0);
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const y = (p: number) => pad.t + ((hi - Math.min(Math.max(p, lo), hi)) / (hi - lo)) * (H - pad.t - pad.b);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.price).toFixed(1)}`).join(" ");
  const nowX = x(Math.min(now, t1));
  const change = last.price / data.close - 1;
  const cushion = last.price / upper - 1;
  const lowerShown = lower > lo;

  return (
    <div className="mt-5 rounded-xl border border-line bg-ink p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-medium">{symbol} since the close</h3>
        <span className="num text-sm">
          {usd(last.price)}{" "}
          <span className={change >= 0 ? "text-gain" : "text-loss"}>
            {change >= 0 ? "+" : ""}
            {pct(change, 2)}
          </span>
        </span>
      </div>
      <div ref={box} className="mt-2 w-full overflow-hidden">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block" role="img" aria-label={`${symbol} at ${usd(last.price)}, ${pct(change, 2)} since the close; protection starts at ${usd(upper)}`}>
          {/* Where the protection pays: from where it starts down to where it stops (or the chart's floor). */}
          <rect x={pad.l} width={W - pad.l - pad.r} y={y(upper)} height={Math.max(0, y(lowerShown ? lower : lo) - y(upper))} fill="var(--color-brass-soft)" />
          <line x1={pad.l} x2={W - pad.r} y1={y(upper)} y2={y(upper)} stroke="var(--color-brass)" strokeDasharray="4 3" />
          <text x={W - pad.r - 4} y={y(upper) + FONT + 2} textAnchor="end" fontSize={FONT} className="fill-[var(--color-brass)]">
            pays below {usd(upper)}
            {lowerShown ? "" : `, down to ${usd(lower)}`}
          </text>
          {lowerShown && <line x1={pad.l} x2={W - pad.r} y1={y(lower)} y2={y(lower)} stroke="var(--color-brass)" strokeOpacity="0.5" />}
          <line x1={pad.l} x2={W - pad.r} y1={y(data.close)} y2={y(data.close)} stroke="var(--color-faint)" strokeDasharray="2 4" />
          <text x={pad.l + 2} y={y(data.close) + FONT + 3} fontSize={FONT} className="fill-[var(--color-faint)]">
            close {usd(data.close)}
          </text>
          {/* The rest of the night, still to come. */}
          <rect x={nowX} width={Math.max(0, W - pad.r - nowX)} y={pad.t - 6} height={H - pad.t - pad.b + 6} fill="var(--color-line)" fillOpacity="0.25" />
          <path d={line} stroke="var(--color-text)" strokeWidth="1.75" fill="none" />
          <circle cx={x(last.t)} cy={y(last.price)} r="3.5" fill="var(--color-text)" />
          <line x1={x(openTs)} x2={x(openTs)} y1={pad.t - 6} y2={H - pad.b} stroke="var(--color-brass)" />
          <text x={x(openTs) - 4} y={pad.t - 10} textAnchor="end" fontSize={FONT} className="fill-[var(--color-brass)]">
            the bell settles it
          </text>
          <text x={pad.l + 2} y={H - 6} fontSize={FONT} className="fill-[var(--color-faint)]">
            {nyTime(t0)}
          </text>
          <text x={W - pad.r - 2} y={H - 6} textAnchor="end" fontSize={FONT} className="fill-[var(--color-faint)]">
            {nyTime(openTs)}
          </text>
        </svg>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        {cushion > 0 ? (
          <>
            {symbol} is <span className="num text-text">{pct(cushion)}</span> above where this protection starts.
          </>
        ) : (
          <>
            {symbol} is already below where this protection starts: at this price it would pay{" "}
            <span className="num text-text">{usd(Math.min(upper - last.price, upper - lower))}</span> a share.
          </>
        )}{" "}
        Traded overnight on Hyperliquid ({data.coin}); only the price at the open counts.
      </p>
    </div>
  );
}
