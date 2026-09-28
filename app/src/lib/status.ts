import type { LedgerRow } from "./api";
import { explorer, nyTime, usd } from "./format";

export type CheckState = "ok" | "warn" | "down";
export type Check = { name: string; state: CheckState; detail: string; href?: string };

/** A keeper is keeping up if no series has waited past the grace period since its open. */
export function keeper(rows: LedgerRow[], now: number, graceSecs: number): Omit<Check, "name"> {
  const late = rows.filter((r) => r.state === "open" && now > r.openTs + graceSecs).sort((a, b) => a.openTs - b.openTs);
  if (late[0]) {
    const mins = Math.round((now - late[0].openTs) / 60);
    return { state: "warn", detail: `${late[0].symbol}'s ${nyTime(late[0].openTs)} series is ${mins} minutes past its open and not settled yet.` };
  }
  const settled = rows.filter((r) => r.state === "settled").sort((a, b) => b.openTs - a.openTs)[0];
  const due = rows.filter((r) => r.state === "open").sort((a, b) => a.openTs - b.openTs)[0];
  const next = due ? ` Next: ${due.symbol} at the ${nyTime(due.openTs)} open.` : "";
  if (!settled) return { state: "ok", detail: `Nothing has settled yet.${next}` };
  return {
    state: "ok",
    detail: `Last settled ${settled.symbol} at ${usd(settled.price ?? 0)} for the ${nyTime(settled.openTs)} open.${next}`,
    ...(settled.chain === "solana" && settled.settleTx ? { href: explorer("tx", settled.settleTx) } : {}),
  };
}
