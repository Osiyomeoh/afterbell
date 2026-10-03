import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { evmChain } from "@root/evm/client/vault";
import { DEFAULT_BAND } from "@root/hedger/target";

import { explorer, nyTime } from "@/lib/format";
import { keeper, type Check, type CheckState } from "@/lib/status";

import { RPC } from "./chain";
import { SOLANA_DEPLOYMENT } from "./deployment";
import { keypairFromEnv } from "./env";
import { evmVaultState } from "./evmChain";
import { evmDeployment } from "./evmDeployment";
import { hedgeSummary } from "./hedge";
import { solanaLedger } from "./ledger";

export type { Check, CheckState };
export type StatusReport = { now: number; checks: Check[] };

/** How long after an open a series may wait for the keeper before it's flagged. */
const SOLANA_GRACE_SECS = 20 * 60;
// Robinhood Chain's keeper runs by hand for now, some time after the open.
const EVM_GRACE_SECS = 3 * 3600;
/** When anyone may void an unsettled series: both vaults' settle window, a day after the open. */
const VOIDABLE_AFTER_SECS = 24 * 3600;
/** The faucet's gift per new wallet, and what a transaction costs it. */
const SOL_PER_WALLET = 0.02;
const FAUCET_RESERVE = 0.005;

/**
 * What's running and whether it's keeping up: each vault's keeper, the
 * hedge, the quote service on each chain and the faucet. Reads public state
 * and the server's own settings; signs and sends nothing.
 */
export async function statusReport(now = Math.floor(Date.now() / 1000)): Promise<StatusReport> {
  const checks = await Promise.all([
    run("Solana keeper", () => solanaLedger().then((rows) => keeper(rows, now, SOLANA_GRACE_SECS, VOIDABLE_AFTER_SECS))),
    run("Robinhood Chain keeper", async () => {
      const s = evmVaultState();
      if (!s) return { state: "warn", detail: "The Robinhood Chain vault isn't deployed here." };
      return keeper((await s).ledger, now, EVM_GRACE_SECS, VOIDABLE_AFTER_SECS, (tx) => `${evmChain(evmDeployment()!).blockExplorers?.default.url}/tx/${tx}`);
    }),
    run("Hedge on Hyperliquid", () => hedge(now)),
    run("Quotes on Solana", async () => solanaQuotes()),
    run("Quotes on Robinhood Chain", async () => evmQuotes()),
    run("Test-money faucet", faucet),
  ]);
  return { now, checks };
}

async function run(name: string, check: () => Promise<Omit<Check, "name">>): Promise<Check> {
  try {
    return { name, ...(await check()) };
  } catch (e) {
    return { name, state: "down", detail: readError(e) };
  }
}

/** A failed read in a sentence: the public RPC's rate limit named plainly, anything else cut short. */
function readError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  if (message.includes("429")) return "Couldn't read it: the public RPC is limiting requests right now. Reload in a minute.";
  const first = message.split("\n")[0]!;
  return `Couldn't read it: ${first.length > 160 ? `${first.slice(0, 160)}…` : first}`;
}

/** The hedger runs every 5 minutes, so a gap it traded on this recently is being closed. */
const REBALANCE_GRACE_SECS = 10 * 60;

async function hedge(now: number): Promise<Omit<Check, "name">> {
  const h = await hedgeSummary();
  if (!h.account) return { state: "warn", detail: "No hedge account is set, so the hedge isn't running." };
  const held = h.account.position?.short ?? 0;
  const off = Math.abs(held - h.target);
  const lastTrade = h.activity?.fills[0]?.time;
  const traded = lastTrade ? ` Last trade ${nyTime(lastTrade)}.` : "";
  // Inside the hedger's own dead band it doesn't trade; outside it, it should have traded lately.
  const band = Math.max(DEFAULT_BAND.minShares, DEFAULT_BAND.minNotional / h.mid);
  const rebalancing = lastTrade !== undefined && now - lastTrade < REBALANCE_GRACE_SECS;
  const state: CheckState = off <= band || rebalancing ? "ok" : "warn";
  const lag = off > band ? ` ${off.toFixed(3)} off target.` : "";
  const site = h.network === "mainnet" ? "hyperliquid.xyz" : "hyperliquid-testnet.xyz";
  return {
    state,
    detail: `Short ${held.toFixed(3)} ${h.symbol} against a target of ${h.target.toFixed(3)} on ${h.network}.${lag}${traded}`,
    href: `https://app.${site}/explorer/address/${h.account.address}`,
  };
}

function solanaQuotes(): Omit<Check, "name"> {
  const d = SOLANA_DEPLOYMENT;
  if (!d) return { state: "down", detail: "No Solana vault is deployed here." };
  const key = keypairFromEnv("QUOTER_SOLANA_KEY");
  if (!key) return { state: "down", detail: "No quoter key is set, so nothing can be sold." };
  if (key.publicKey.toBase58() !== d.quoter) return { state: "down", detail: "The quoter key set here isn't the vault's quoter." };
  return { state: "ok", detail: `Signing for the vault's quoter ${d.quoter.slice(0, 4)}…${d.quoter.slice(-4)}.` };
}

function evmQuotes(): Omit<Check, "name"> {
  const d = evmDeployment();
  if (!d) return { state: "warn", detail: "The Robinhood Chain vault isn't deployed here." };
  const key = process.env.QUOTER_EVM_KEY as Hex | undefined;
  if (!key) return { state: "down", detail: "No quoter key is set, so nothing can be sold." };
  if (privateKeyToAccount(key).address.toLowerCase() !== d.quoter.toLowerCase()) return { state: "down", detail: "The quoter key set here isn't the vault's quoter." };
  return { state: "ok", detail: `Signing for the vault's quoter ${d.quoter.slice(0, 6)}…${d.quoter.slice(-4)}.` };
}

async function faucet(): Promise<Omit<Check, "name">> {
  const key = keypairFromEnv("FAUCET_SOLANA_KEY");
  if (!key) return { state: "down", detail: "No faucet key is set, so new wallets get no test money." };
  const sol = (await new Connection(RPC, "confirmed").getBalance(key.publicKey)) / LAMPORTS_PER_SOL;
  const wallets = Math.max(0, Math.floor((sol - FAUCET_RESERVE) / SOL_PER_WALLET));
  const state: CheckState = wallets < 1 ? "down" : wallets < 25 ? "warn" : "ok";
  return { state, detail: `${sol.toFixed(3)} devnet SOL: enough for about ${wallets} new wallet${wallets === 1 ? "" : "s"}.`, href: explorer("address", key.publicKey.toBase58()) };
}
