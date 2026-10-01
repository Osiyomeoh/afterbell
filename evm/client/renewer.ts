/**
 * The renewer beside the vault: a holder's standing order ("protect every
 * night"), set once with a permit for the premiums, and renewed for each
 * opening with a quote the quoter signed for the renewer.
 */
import type { Account, Address, Chain, Hex, PublicClient, Transport, WalletClient } from "viem";

import type { EvmQuote } from "../../pricing/quote";

import { afterbellRenewerAbi } from "./abi";
import { signPermit, type EvmDeployment } from "./vault";

type Wallet = WalletClient<Transport, Chain, Account>;

/** A standing order as the renewer stores it: shares 6 decimals, premium in the collateral's units, levels in basis points. */
export type RenewerOrder = { maxShares: bigint; startBps: number; depthBps: number; maxPremium: bigint; until: bigint; lastOpenTs: bigint };
export type HolderOrder = RenewerOrder & { holder: Address; feed: Address };

const PAGE = 100n;

/** Every order still standing: set, not cancelled, and not past its end. */
export async function activeOrders(client: PublicClient, renewer: Address, now: bigint): Promise<HolderOrder[]> {
  const count = await client.readContract({ address: renewer, abi: afterbellRenewerAbi, functionName: "orderCount" });
  const keys: { holder: Address; feed: Address }[] = [];
  for (let start = 0n; start < count; start += PAGE) {
    keys.push(...(await client.readContract({ address: renewer, abi: afterbellRenewerAbi, functionName: "orderKeys", args: [start, PAGE] })));
  }
  const orders = await Promise.all(
    keys.map(async (k) => ({ ...k, ...(await client.readContract({ address: renewer, abi: afterbellRenewerAbi, functionName: "order", args: [k.holder, k.feed] })) })),
  );
  return orders.filter((o) => o.maxShares > 0n && o.until >= now);
}

/**
 * Sets the wallet's standing order on `feed`, with a permit for `allowance`
 * of the collateral (what the renewer may take over all renewals), in one
 * transaction.
 */
export async function setOrder(
  wallet: Wallet,
  client: PublicClient,
  d: Pick<EvmDeployment, "testUsd"> & { renewer: Address },
  feed: Address,
  o: Omit<RenewerOrder, "lastOpenTs">,
  allowance: bigint,
): Promise<Hex> {
  const p = await signPermit(wallet, client, { vault: d.renewer, testUsd: d.testUsd }, allowance);
  const hash = await wallet.writeContract({
    address: d.renewer,
    abi: afterbellRenewerAbi,
    functionName: "setOrderWithPermit",
    args: [feed, o.maxShares, o.startBps, o.depthBps, o.maxPremium, o.until, allowance, p.deadline, p.v, p.r, p.s],
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`setting the order reverted (${hash})`);
  return hash;
}

/** Ends the wallet's order on `feed`. */
export async function cancelOrder(wallet: Wallet, client: PublicClient, renewer: Address, feed: Address): Promise<Hex> {
  const hash = await wallet.writeContract({ address: renewer, abi: afterbellRenewerAbi, functionName: "cancel", args: [feed] });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`cancelling the order reverted (${hash})`);
  return hash;
}

/** Renews `holder`'s order with a quote signed for the renewer. Anyone may. */
export async function renewOrder(wallet: Wallet, client: PublicClient, renewer: Address, holder: Address, quote: EvmQuote, signature: Hex): Promise<Hex> {
  const hash = await wallet.writeContract({ address: renewer, abi: afterbellRenewerAbi, functionName: "renew", args: [holder, quote, signature] });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`the renewal reverted (${hash})`);
  return hash;
}
