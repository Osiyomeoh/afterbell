"use client";

import { useEffect, useRef, useState } from "react";

import { usd } from "@/lib/format";

const FONT = 12;
// Geist at 12px averages about 7px a character for prices; enough to keep labels apart.
const textWidth = (s: string) => s.length * 7;

/**
 * What the protection pays at each opening price, against what it costs.
 * Pays nothing above `upper`, the loss below it, capped at `lower`. Drawn at
 * the width it's given, so labels stay 12px on a phone.
 */
export function PayoffChart(props: { shares: number; upper: number; lower: number; premium: number; reference: number }) {
  const { shares, upper, lower, premium, reference } = props;
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(560);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setW(Math.max(240, Math.round(el.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const H = W < 480 ? 180 : 200;
  const pad = { l: 4, r: 4, t: 24, b: 26 };
  const lo = lower - (upper - lower) * 0.25;
  const hi = Math.max(reference, upper) + (upper - lower) * 0.25;
  const maxPay = shares * (upper - lower);
  const x = (p: number) => pad.l + ((p - lo) / (hi - lo)) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - (v / maxPay) * (H - pad.t - pad.b);
  const pay = (p: number) => shares * Math.min(Math.max(upper - p, 0), upper - lower);
  const path = [lo, lower, upper, hi].map((p, i) => `${i ? "L" : "M"}${x(p).toFixed(1)},${y(pay(p)).toFixed(1)}`).join(" ");
  // Keep a centred label inside the chart.
  const fit = (cx: number, label: string) => Math.min(Math.max(cx, pad.l + textWidth(label) / 2), W - pad.r - textWidth(label) / 2);

  // The two strikes share the axis; when they're too close to label apart, label the range once.
  const lowerLabel = usd(lower);
  const upperLabel = usd(upper);
  const apart = x(upper) - x(lower) >= (textWidth(lowerLabel) + textWidth(upperLabel)) / 2 + 8;
  const axis = apart
    ? [
        { at: x(lower), label: lowerLabel },
        { at: x(upper), label: upperLabel },
      ]
    : [{ at: (x(lower) + x(upper)) / 2, label: `${lowerLabel}–${upperLabel}` }];
  const nowLabel = `now ${usd(reference)}`;
  // The premium's label sits above its line unless that would run into the payout's.
  const premiumY = y(premium) - y(maxPay) < 2 * FONT + 4 ? y(premium) + FONT + 4 : y(premium) - 6;

  return (
    <div ref={box} className="w-full overflow-hidden">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block" role="img" aria-label={`Pays up to ${usd(maxPay)} if the stock opens below ${usd(upper)}`}>
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="var(--color-line)" />
        <path d={`${path} L${x(hi)},${y(0)} L${x(lo)},${y(0)} Z`} fill="var(--color-brass-soft)" />
        <path d={path} stroke="var(--color-brass)" strokeWidth="2" fill="none" />
        <line x1={pad.l} x2={W - pad.r} y1={y(premium)} y2={y(premium)} stroke="var(--color-faint)" strokeDasharray="4 4" />
        <text x={pad.l + 4} y={premiumY} fontSize={FONT} className="fill-[var(--color-muted)]">
          premium {usd(premium)}
        </text>
        <text x={pad.l + 4} y={y(maxPay) - 8} fontSize={FONT} className="fill-[var(--color-brass)]">
          pays up to {usd(maxPay)}
        </text>
        <line x1={x(reference)} x2={x(reference)} y1={pad.t - 4} y2={y(0)} stroke="var(--color-muted)" strokeDasharray="2 3" />
        <text x={fit(x(reference), nowLabel)} y={pad.t - 10} textAnchor="middle" fontSize={FONT} className="fill-[var(--color-muted)]">
          {nowLabel}
        </text>
        {axis.map((a) => (
          <text key={a.label} x={fit(a.at, a.label)} y={H - 8} textAnchor="middle" fontSize={FONT} className="fill-[var(--color-faint)]">
            {a.label}
          </text>
        ))}
      </svg>
    </div>
  );
}
