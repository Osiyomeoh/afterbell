/**
 * Afterbell's MCP tools, shared by two servers:
 *
 *   - hosted (app route /mcp, HTTP): holds no keys. Anyone can add it by URL
 *     to read the market, price protection, follow positions and get an
 *     unsigned transaction for their own wallet to sign.
 *   - local (agent/server.ts, stdio): adds the agent's own devnet wallet, so
 *     it can buy and claim by itself under a spending cap (wallet.ts).
 *
 * Both price through the app's public routes, exactly as the site does.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { z } from "zod";

import { backtest } from "../pricing/backtest";
import type { SolanaQuote } from "../pricing/solanaQuote";
import { priceQuote, type PricedProtection } from "../quoter/quoter";
import { buyInstructions, getProgram } from "../solana/client/vault";
import { AfterbellApi, toMarket, type MarketInfo, type SolanaQuoteResponse } from "./api";

export const SOLANA_RPC = process.env.SOLANA_RPC || "https://api.devnet.solana.com";

const ABOUT = `Afterbell sells protection for tokenized stocks until the next 09:30 ET opening bell. Tokenized stocks trade
around the clock but the stock doesn't, so whatever happens while the exchange is shut lands on the next opening print.
Protection is a put spread: pay a premium once; if TSLA opens below where protection starts, the vault pays the
difference per share, down to where it stops. Settled on-chain by the first Pyth price at or after 09:30 ET, so it
never pays more than a holder loses. Solana devnet; all money is TestUSD, which has no value.`;

const HOSTED = `${ABOUT}
This hosted server holds no keys and spends nothing. market shows TSLA's price and the next open; quote_protection
prices protection (show the user the cost and what it pays before buying); protect_portfolio sizes protection to the
TSLAx and TSLAon a Solana wallet holds. To buy, protection_transaction or protect_portfolio returns an unsigned
transaction for the buyer's own wallet to sign (a fresh devnet wallet is sent test money first). positions follows any
wallet; vault shows the vault's collateral and every series. An agent that should hold its own wallet and buy by itself
can run the local server from the Afterbell repo (agent/server.ts).`;

const LOCAL = `${ABOUT}
Typical flow: wallet, then get_test_funds the first time. market shows TSLA's price and the next open;
quote_protection prices protection; show the user the cost and what it pays and get their agreement before
buy_protection, which spends from the agent's wallet up to its spending cap. protect_portfolio does the same sized to
what a mainnet wallet holds. positions follows the agent's protection; after the open settles, claim collects payouts
(a keeper also claims for everyone).`;

export const read = { readOnlyHint: true, openWorldHint: true } as const;

const protectionArgs = {
  shares: z.number().positive().optional().describe("Shares of TSLA to protect."),
  starts_below: z.number().min(0).max(20).optional().describe("Where protection starts, in percent below the price. Default 2."),
  stops_below: z.number().min(0.5).max(50).optional().describe("Where protection stops, in percent below the price. Default 10."),
};

const usd = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const nyTime = (unix: number) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(unix * 1000)) + " ET";

/** Tool results are plain text for the model; failures come back as tool errors, not crashes. */
export async function respond(fn: () => Promise<string>) {
  try {
    return { content: [{ type: "text" as const, text: await fn() }] };
  } catch (e) {
    return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
  }
}

/** Protection from `starts_below`% to `stops_below`% under the price it's priced from. */
export function protectionFor(m: MarketInfo, shares: number, startsBelow = 2, stopsBelow = 10) {
  if (m.paused || !m.reference) throw new Error(`Sales are paused: ${m.paused ?? "no price"}.`);
  if (!(stopsBelow > startsBelow)) throw new Error("stops_below must be further below the price than starts_below.");
  const ref = m.reference.price;
  const round2 = (v: number) => Math.round(v * 100) / 100;
  return { shares: Math.round(shares * 10_000) / 10_000, upper: round2(ref * (1 - startsBelow / 100)), lower: round2(ref * (1 - stopsBelow / 100)) };
}

export function describe(p: PricedProtection): string {
  return [
    `Protection for ${p.protection.shares} TSLA until ${nyTime(p.openTs)}: pay ${usd(p.premium)}.`,
    `If TSLA opens below ${usd(p.protection.upper)}, it pays ${usd(p.protection.shares)} for every dollar below, up to ${usd(p.maxPayout)} at ${usd(p.protection.lower)} or lower.`,
    `Chance it pays anything: ${(p.probabilityOfPayout * 100).toFixed(1)}% (from ${p.model.openings} past TSLA openings). Priced from ${usd(p.reference.price)} (${p.reference.basis}).`,
  ].join("\n");
}

/** How many shares: given, or what `holder` holds on mainnet. */
export async function sharesFor(api: AfterbellApi, shares: number | undefined, holder: string | undefined): Promise<number> {
  if (shares !== undefined) return shares;
  if (!holder) throw new Error("Give shares, or holder (a Solana mainnet wallet) to size protection to what it holds.");
  const held = (await api.holdings(holder)).reduce((a, h) => a + h.shares, 0);
  if (!(held > 0)) throw new Error(`${holder} holds no TSLAx or TSLAon on mainnet.`);
  return held;
}

export function toSolanaQuote(q: SolanaQuoteResponse["solana"]["quote"]): SolanaQuote {
  const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
  return {
    feedId: bytes(q.feedId),
    openTs: BigInt(q.openTs),
    shares: BigInt(q.shares),
    upper: BigInt(q.upper),
    lower: BigInt(q.lower),
    premium: BigInt(q.premium),
    expiry: BigInt(q.expiry),
    nonce: bytes(q.nonce),
  };
}

/** The purchase for `buyer` to sign: the Ed25519 check of the quote, then `buy`. */
export async function purchase(connection: Connection, buyer: PublicKey, r: SolanaQuoteResponse): Promise<Transaction> {
  const unsigned = { publicKey: buyer, signTransaction: () => Promise.reject(new Error("unsigned")), signAllTransactions: () => Promise.reject(new Error("unsigned")) };
  const mint = new PublicKey(r.solana.collateralMint);
  const ixs = await buyInstructions(getProgram(connection, unsigned), {
    buyer,
    vault: new PublicKey(r.solana.vault),
    collateralMint: mint,
    buyerToken: getAssociatedTokenAddressSync(mint, buyer),
    quote: toSolanaQuote(r.solana.quote),
    ed25519Data: Uint8Array.from(Buffer.from(r.solana.ed25519Data, "base64")),
  });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  return new Transaction({ feePayer: buyer, blockhash, lastValidBlockHeight }).add(...ixs);
}

export type AgentWalletTools = {
  wallet(): Promise<string>;
  getTestFunds(): Promise<string>;
  buy(shares: number, startsBelow?: number, stopsBelow?: number, maxCost?: number): Promise<string>;
  claim(): Promise<string>;
  address(): string;
};

export function createServer(kind: "hosted" | "local", api: AfterbellApi, wallet?: AgentWalletTools): McpServer {
  const server = new McpServer({ name: "afterbell", version: "0.1.0" }, { instructions: kind === "local" ? LOCAL : HOSTED });

  server.registerTool(
    "market",
    {
      title: "TSLA and the next open",
      description: "TSLA's last close and live price, whether the exchange is open, the next 09:30 ET open protection settles on, and whether protection is on sale.",
      inputSchema: {},
      annotations: read,
    },
    () =>
      respond(async () => {
        const m = await api.market();
        return [
          `TSLA closed at ${usd(m.close)} (${nyTime(m.closeTs)}, ${m.closeSource === "pyth" ? "Pyth" : "Hyperliquid"}).`,
          m.live !== null ? `Now ${usd(m.live)} on ${m.liveSource === "pyth" ? "Pyth" : "Hyperliquid"}; the exchange is ${m.inSession ? "open" : "closed"}.` : "",
          `The next open protection settles on: ${nyTime(m.nextOpen)}.`,
          m.paused ? `Sales are paused: ${m.paused}.` : `Protection is priced from ${usd(m.reference!.price)} (${m.reference!.basis}).`,
        ]
          .filter(Boolean)
          .join("\n");
      }),
  );

  server.registerTool(
    "quote_protection",
    {
      title: "Price protection",
      description:
        "Prices protection on TSLA until the next open: the premium, the most it pays, the chance it pays, and how the same protection did on every past TSLA opening. Spends nothing.",
      inputSchema: { ...protectionArgs, holder: z.string().optional().describe("A Solana mainnet wallet: size protection to the TSLAx and TSLAon it holds.") },
      annotations: read,
    },
    ({ shares, holder, starts_below, stops_below }) =>
      respond(async () => {
        const m = await api.market();
        const p = priceQuote(Math.floor(Date.now() / 1000), toMarket(m), protectionFor(m, await sharesFor(api, shares, holder), starts_below, stops_below), m.config);
        const start = (starts_below ?? 2) / 100;
        const record = backtest(m.history, { deductible: start, depth: (stops_below ?? 10) / 100 }, { shares: 1, annualVol: m.annualVol, margin: m.config.margin });
        return `${describe(p)}\nReplayed on ${record.nights.length} past TSLA openings, each priced only from the ones before it, this protection paid back ${Math.round(record.paidPerDollar * 100)}¢ per $1 of premium and paid out on ${record.paidNights} of them.\nTo buy: ${kind === "local" ? "buy_protection" : "protection_transaction"} with the same arguments.`;
      }),
  );

  server.registerTool(
    "positions",
    {
      title: "Protection held",
      description: "A wallet's protection that hasn't been claimed yet: what it covers, what it cost, and once the open has settled, what it pays.",
      inputSchema: { owner: z.string().optional().describe(kind === "local" ? "A Solana wallet. Default: the agent's." : "A Solana wallet.") },
      annotations: read,
    },
    ({ owner }) =>
      respond(async () => {
        const who = owner ?? wallet?.address();
        if (!who) throw new Error("Give owner, a Solana wallet.");
        const ps = await api.positions(who);
        if (ps.length === 0) return `${who} holds no unclaimed protection.`;
        return ps
          .map((p) => {
            const status = p.state === "open" ? `open until ${nyTime(p.openTs)}` : p.state === "voided" ? `voided: claim refunds ${usd(p.claimable ?? 0)}` : `opened at ${usd(p.settlementPrice ?? 0)}: claim pays ${usd(p.claimable ?? 0)}`;
            return `${p.shares} TSLA protected from ${usd(p.upper)} to ${usd(p.lower)}, paid ${usd(p.premium)}, pays up to ${usd(p.maxPayout)}; ${status}.`;
          })
          .join("\n");
      }),
  );

  server.registerTool(
    "vault",
    {
      title: "The vault",
      description: "The vault's collateral, what's locked for open protection, and every series with how it settled (its track record).",
      inputSchema: {},
      annotations: read,
    },
    () =>
      respond(async () => {
        const v = await api.vault();
        const lines = v.series.map((s) => `${nyTime(s.openTs)}: ${s.state === "settled" ? `settled at ${usd(s.price ?? 0)}` : s.state}, ${s.positions} unclaimed positions, ${usd(s.premiums)} in premiums`);
        return [`Collateral ${usd(v.collateral)} TestUSD, ${usd(v.locked)} locked for open protection (every sale locks its maximum payout).`, ...lines].join("\n");
      }),
  );

  if (kind === "hosted") {
    const transactionFor = async (buyer: string, shares: number, startsBelow?: number, stopsBelow?: number) => {
      const owner = new PublicKey(buyer);
      const m = await api.market();
      const r = await api.quote(buyer, protectionFor(m, shares, startsBelow, stopsBelow));
      const connection = new Connection(SOLANA_RPC, "confirmed");
      // A fresh devnet wallet gets test money first, so it can pay.
      const funded = await api.faucet(buyer).catch(() => null);
      const tx = await purchase(connection, owner, r);
      return [
        describe(r.priced),
        funded && !funded.alreadyFunded ? `Sent ${buyer} ${funded.testUsd} TestUSD and ${funded.sol} SOL first.` : "",
        `Unsigned transaction (base64; sign with ${buyer} and send to Solana devnet within about a minute, before the quote expires):`,
        tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
      ]
        .filter(Boolean)
        .join("\n");
    };

    server.registerTool(
      "protection_transaction",
      {
        title: "Transaction to buy protection",
        description: "Returns an unsigned transaction that buys the protection quote_protection describes, for the buyer's own devnet wallet to sign. Quote first and get the user's agreement to the cost.",
        inputSchema: { buyer: z.string().describe("The Solana devnet wallet that pays and holds the protection."), ...protectionArgs },
        annotations: { openWorldHint: true },
      },
      ({ buyer, shares, starts_below, stops_below }) =>
        respond(async () => {
          if (shares === undefined) throw new Error("Give shares, or use protect_portfolio to size protection to a wallet's holdings.");
          return transactionFor(buyer, shares, starts_below, stops_below);
        }),
    );

    server.registerTool(
      "protect_portfolio",
      {
        title: "Protect a portfolio",
        description: "Sizes protection to the TSLAx and TSLAon a Solana wallet holds on mainnet and returns the unsigned transaction to buy it on devnet.",
        inputSchema: {
          holder: z.string().describe("The Solana mainnet wallet whose TSLAx and TSLAon to protect."),
          buyer: z.string().optional().describe("The devnet wallet that pays. Default: the holder."),
          starts_below: protectionArgs.starts_below,
          stops_below: protectionArgs.stops_below,
        },
        annotations: { openWorldHint: true },
      },
      ({ holder, buyer, starts_below, stops_below }) => respond(async () => transactionFor(buyer ?? holder, await sharesFor(api, undefined, holder), starts_below, stops_below)),
    );
  }

  if (kind === "local" && wallet) {
    server.registerTool(
      "wallet",
      { title: "Agent wallet", description: "The agent's devnet wallet: address, TestUSD and SOL, and its spending cap. Creates it on first use.", inputSchema: {}, annotations: { openWorldHint: true } },
      () => respond(() => wallet.wallet()),
    );
    server.registerTool(
      "get_test_funds",
      { title: "Get test money", description: "Tops the agent's wallet up with TestUSD and a little devnet SOL from the Afterbell faucet.", inputSchema: {}, annotations: { openWorldHint: true } },
      () => respond(() => wallet.getTestFunds()),
    );
    server.registerTool(
      "buy_protection",
      {
        title: "Buy protection",
        description: "Buys the protection quote_protection describes from the agent's wallet. Fails without spending if the premium is above max_cost or the agent's spending cap. Quote first and get the user's agreement to the cost.",
        inputSchema: { ...protectionArgs, max_cost: z.number().positive().optional().describe("Most to pay, in TestUSD.") },
        annotations: { openWorldHint: true },
      },
      ({ shares, starts_below, stops_below, max_cost }) =>
        respond(async () => {
          if (shares === undefined) throw new Error("Give shares, or use protect_portfolio.");
          return wallet.buy(shares, starts_below, stops_below, max_cost);
        }),
    );
    server.registerTool(
      "protect_portfolio",
      {
        title: "Protect a portfolio",
        description: "Sizes protection to the TSLAx and TSLAon a Solana mainnet wallet holds and buys it from the agent's wallet, under its spending cap.",
        inputSchema: { holder: z.string().describe("The Solana mainnet wallet whose holdings to protect."), starts_below: protectionArgs.starts_below, stops_below: protectionArgs.stops_below, max_cost: z.number().positive().optional() },
        annotations: { openWorldHint: true },
      },
      ({ holder, starts_below, stops_below, max_cost }) => respond(async () => wallet.buy(await sharesFor(api, undefined, holder), starts_below, stops_below, max_cost)),
    );
    server.registerTool(
      "claim",
      { title: "Claim", description: "Claims every settled or voided protection the agent holds, paying out (or refunding) into its wallet.", inputSchema: {}, annotations: { openWorldHint: true } },
      () => respond(() => wallet.claim()),
    );
  }
  return server;
}
