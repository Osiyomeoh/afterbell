import { usd } from "@/lib/format";
import type { PricedProtection } from "@root/quoter/quoter";

/** On phones, the price and buy button pinned to the bottom while the ticket is in view but its checkout isn't. */
export function MobileBar(props: { priced?: PricedProtection | null; blocked?: string | null; busy: boolean; label: string; onBuy: () => void }) {
  const { priced, blocked, busy, label, onBuy } = props;
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur lg:hidden">
      <div className="mx-auto flex max-w-xl items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="num text-lg font-semibold leading-tight">{priced ? usd(priced.premium) : "—"}</div>
          <div className="num truncate text-xs text-muted">{priced ? `pays up to ${usd(priced.maxPayout, 0)}` : blocked ?? ""}</div>
        </div>
        <button
          onClick={onBuy}
          disabled={!!blocked || busy}
          className="shrink-0 rounded-xl bg-brass px-4 py-2.5 text-sm font-medium text-ink transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {label}
        </button>
      </div>
    </div>
  );
}
