import { usd } from "@/lib/format";

/**
 * What the protection pays at each opening price, against what it costs.
 * Pays nothing above `upper`, the loss below it, capped at `lower`.
 */
export function PayoffChart(props: { shares: number; upper: number; lower: number; premium: number; reference: number }) {
  const { shares, upper, lower, premium, reference } = props;
  const W = 560;
  const H = 200;
  const pad = { l: 8, r: 8, t: 16, b: 28 };
  const lo = lower - (upper - lower) * 0.25;
  const hi = Math.max(reference, upper) + (upper - lower) * 0.25;
  const maxPay = shares * (upper - lower);
  const x = (p: number) => pad.l + ((p - lo) / (hi - lo)) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - (v / maxPay) * (H - pad.t - pad.b);
  const pay = (p: number) => shares * Math.min(Math.max(upper - p, 0), upper - lower);
  const path = [lo, lower, upper, hi].map((p, i) => `${i ? "L" : "M"}${x(p).toFixed(1)},${y(pay(p)).toFixed(1)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Pays up to ${usd(maxPay)} if the stock opens below ${usd(upper)}`}>
      <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="var(--color-line)" />
      <line x1={pad.l} x2={W - pad.r} y1={y(premium)} y2={y(premium)} stroke="var(--color-faint)" strokeDasharray="4 4" />
      <text x={W - pad.r} y={y(premium) - 6} textAnchor="end" className="fill-[var(--color-faint)] text-[11px]">
        premium {usd(premium)}
      </text>
      <path d={`${path} L${x(hi)},${y(0)} L${x(lo)},${y(0)} Z`} fill="var(--color-brass-soft)" />
      <path d={path} stroke="var(--color-brass)" strokeWidth="2" fill="none" />
      <text x={x(lo) + 4} y={y(maxPay) - 6} className="fill-[var(--color-brass)] text-[11px]">
        pays {usd(maxPay)}
      </text>
      <line x1={x(reference)} x2={x(reference)} y1={pad.t} y2={y(0)} stroke="var(--color-muted)" strokeDasharray="2 3" />
      <text x={x(reference)} y={H - 10} textAnchor="middle" className="fill-[var(--color-muted)] text-[11px]">
        now {usd(reference)}
      </text>
      {[lower, upper].map((p) => (
        <text key={p} x={x(p)} y={H - 10} textAnchor="middle" className="fill-[var(--color-faint)] text-[11px]">
          {usd(p)}
        </text>
      ))}
    </svg>
  );
}
