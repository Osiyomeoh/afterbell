import { createPublicClient, http, parseAbiItem, type Address } from "viem";

import { evmChain } from "@root/evm/client/vault";
import featured from "@root/privacy/featured.json";

import { explorer } from "@/lib/format";
import { buyers, FIRST_CAMPAIGN_OPEN } from "@/lib/team";

import { solanaVaultState } from "./chain";
import { SOLANA_DEPLOYMENT } from "./deployment";
import { evmVaultState } from "./evmChain";
import { evmDeployment } from "./evmDeployment";
import { hedgeSummary } from "./hedge";
import { solanaLedger } from "./ledger";

export type Proof = { label: string; detail: string; href: string };

/** One opening across both chains: what was covered, what it took in and what it paid. */
export type Night = { openTs: number; day: string; symbols: string[]; positions: number; premiums: number; paid: number };

/** The book over the hedge's window: premiums in, payouts out, and what the TSLA short made or lost. */
export type Book = { since: number; premiums: number; paid: number; hedgePnl: number; fees: number; funding: number; net: number };

export type VerifyView = {
  counts: { openings: number; positions: number; wallets: number; outside: number; paid: number; renewals: number; hedgeTrades: number };
  /** When outside buyers start counting. */
  campaignOpen: number;
  settlements: Proof[];
  /** Every settled opening, newest first. */
  nights: Night[];
  renewals: Proof[];
  hedge: Proof[];
  /** Null until the hedge account reports. */
  book: Book | null;
  privacy: Proof[];
  contracts: Proof[];
};

const TTL_MS = 5 * 60_000;
let cache: { at: number; view: Promise<VerifyView> } | null = null;

/** Every claim the app makes, each with the transaction or account that shows it. Cached for five minutes. */
export function verifyView(): Promise<VerifyView> {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    const view = load();
    cache = { at: Date.now(), view };
    view.catch(() => (cache = null));
  }
  return cache.view;
}

const nyDay = (unix: number) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", day: "numeric", month: "short" }).format(new Date(unix * 1000));
const dollars = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function load(): Promise<VerifyView> {
  const d = evmDeployment();
  const client = d ? createPublicClient({ chain: evmChain(d), transport: http(d.rpc) }) : null;
  const evmExplorer = d ? evmChain(d).blockExplorers?.default.url : undefined;
  const evmTx = (hash: string) => `${evmExplorer}/tx/${hash}`;
  const evmAddress = (a: string) => `${evmExplorer}/address/${a}`;

  const [solana, solanaState, evm, hedge, settledLogs, renewedLogs] = await Promise.all([
    solanaLedger().catch(() => []),
    solanaVaultState()?.catch(() => null) ?? null,
    evmVaultState()?.catch(() => null) ?? null,
    hedgeSummary().catch(() => null),
    client && d?.vaultBlock
      ? client
          .getLogs({
            address: d.vault,
            event: parseAbiItem("event SeriesSettled(address indexed feed, uint64 indexed openTs, uint64 price, uint80 roundId)"),
            fromBlock: BigInt(d.vaultBlock),
          })
          .catch(() => [])
      : [],
    client && d?.renewer && d.renewerBlock
      ? client
          .getLogs({
            address: d.renewer,
            event: parseAbiItem("event Renewed(address indexed holder, address indexed feed, uint64 indexed openTs, uint256 positionId, uint128 premium)"),
            fromBlock: BigInt(d.renewerBlock),
          })
          .catch(() => [])
      : [],
  ]);

  const evmLedger = evm?.ledger ?? [];
  // Solana's current vault holds its own series; any other is the first vault's, retired.
  const current = new Set(solanaState?.series.map((x) => x.address) ?? []);
  const settledTx = new Map(settledLogs.map((l) => [Number(l.args.openTs), l.transactionHash]));
  const settlements: Proof[] = [...solana, ...evmLedger]
    .filter((r) => r.state === "settled" && r.price !== null)
    .sort((a, b) => b.openTs - a.openTs)
    .map((r) => {
      const onSolana = r.chain === "solana";
      const tx = onSolana ? r.settleTx : settledTx.get(r.openTs);
      return {
        label: `${r.symbol}, ${nyDay(r.openTs)} open: ${dollars(r.price!)}`,
        detail: `${onSolana ? `Solana${current.has(r.series) ? "" : " (the first vault)"}, Pyth's opening print` : "Robinhood Chain, Chainlink's round in force at the open"}; ${r.sales} sold, ${dollars(r.paid)} paid`,
        href: tx ? (onSolana ? explorer("tx", tx) : evmTx(tx)) : onSolana ? explorer("address", r.series) : evmAddress(d!.vault),
      };
    });

  const byNight = new Map<string, Night>();
  for (const r of [...solana, ...evmLedger].filter((r) => r.state === "settled")) {
    const day = nyDay(r.openTs);
    const n = byNight.get(day) ?? { openTs: r.openTs, day, symbols: [], positions: 0, premiums: 0, paid: 0 };
    if (!n.symbols.includes(r.symbol)) n.symbols.push(r.symbol);
    n.positions += r.sales;
    n.premiums += r.premiums;
    n.paid += r.paid;
    byNight.set(day, n);
  }
  const nights = [...byNight.values()].sort((a, b) => b.openTs - a.openTs);

  const renewals: Proof[] = renewedLogs.map((l) => ({
    label: `${dollars(Number(l.args.premium) / 1e6)}, position #${l.args.positionId}, for the ${nyDay(Number(l.args.openTs))} open`,
    detail: `Bought by the renewer for ${l.args.holder!.slice(0, 6)}…${l.args.holder!.slice(-4)} within their standing order; the NFT went to them`,
    href: evmTx(l.transactionHash),
  }));

  const sales = [...(solanaState?.sales ?? []), ...(evm?.sales ?? [])];
  const wallets = buyers(sales);
  const activity = hedge?.activity;
  const hedgeProofs: Proof[] =
    hedge?.account && activity
      ? [
          {
            label: `${activity.trades} trades, ${dollars(activity.closedPnl)} closed`,
            detail: `A short in xyz:TSLA on Hyperliquid ${hedge.network}, sized to the open protection on both chains`,
            href: `https://app.${hedge.network === "mainnet" ? "hyperliquid.xyz" : "hyperliquid-testnet.xyz"}/explorer/address/${hedge.account.address}`,
          },
        ]
      : [];

  const run = featured.entry;
  const solanaTx = (sig: string) => explorer("tx", sig);
  const privacy: Proof[] = [
    { label: "The holder's round deposit into a private balance", detail: "Public, as every deposit is", href: solanaTx(run.txs.deposit) },
    { label: "The premium, as a confidential transfer", detail: "No token and no amount in the transaction", href: solanaTx(run.txs.premium) },
    { label: "The desk's purchase, in its own name", detail: `${run.shares} ${run.symbol}, $${run.upper} to $${run.lower}`, href: solanaTx(run.txs.buy) },
  ];

  const contracts: Proof[] = [
    ...(SOLANA_DEPLOYMENT
      ? [
          { label: "Solana vault program", detail: SOLANA_DEPLOYMENT.programId, href: explorer("address", SOLANA_DEPLOYMENT.programId) },
          { label: "Solana vault", detail: SOLANA_DEPLOYMENT.vault, href: explorer("address", SOLANA_DEPLOYMENT.vault) },
        ]
      : []),
    ...(d
      ? [
          { label: "Robinhood Chain vault", detail: d.vault, href: evmAddress(d.vault) },
          { label: "Robinhood Chain positions (NFTs)", detail: d.positions, href: evmAddress(d.positions) },
          ...(d.renewer ? [{ label: "Robinhood Chain renewer", detail: d.renewer, href: evmAddress(d.renewer as Address) }] : []),
        ]
      : []),
  ];

  const window = activity ? nights.filter((n) => n.openTs >= activity.since) : [];
  const premiums = window.reduce((t, n) => t + n.premiums, 0);
  const paidOut = window.reduce((t, n) => t + n.paid, 0);
  const book: Book | null = activity
    ? {
        since: activity.since,
        premiums,
        paid: paidOut,
        hedgePnl: activity.closedPnl,
        fees: activity.fees,
        funding: activity.funding,
        net: premiums - paidOut + activity.closedPnl - activity.fees + activity.funding,
      }
    : null;

  return {
    counts: {
      openings: settlements.length,
      positions: [...solana, ...evmLedger].reduce((t, r) => t + r.sales, 0),
      wallets: wallets.all.length,
      outside: wallets.outside.length,
      paid: [...solana, ...evmLedger].reduce((t, r) => t + r.paid, 0),
      renewals: renewals.length,
      hedgeTrades: activity?.trades ?? 0,
    },
    campaignOpen: FIRST_CAMPAIGN_OPEN,
    settlements,
    nights,
    renewals,
    hedge: hedgeProofs,
    book,
    privacy,
    contracts,
  };
}
