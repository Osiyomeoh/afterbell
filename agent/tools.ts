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
import { Connection, PublicKey } from "@solana/web3.js";
import { z } from "zod";

import { backtest } from "../pricing/backtest";
import { formatBook, type GapReport } from "../quoter/gapReport";
import { priceQuote, type PricedProtection } from "../quoter/quoter";
import { AfterbellClient, solanaPurchase, toMarket, type KaminoLoansResponse, type MarketInfo, type PriceSource } from "../sdk/index";

export const SOLANA_RPC = process.env.SOLANA_RPC || "https://api.devnet.solana.com";

const ABOUT = `Afterbell sells protection for tokenized stocks until the next 09:30 ET opening bell. Tokenized stocks trade
around the clock but the stock doesn't, so whatever happens while the exchange is shut lands on the next opening print.
Protection is a put spread: pay a premium once; if the stock opens below where protection starts, the vault pays the
difference per share, down to where it stops. Each position is an NFT, and whoever holds it is paid. On Solana devnet
it is settled on-chain by the first Pyth price at or after 09:30 ET; market says which stocks are on sale there. Every stock the app covers can be priced; the rest settle
on Robinhood Chain's Chainlink feeds, where the app sells them. All money is TestUSD, which has no value.`;

const HOSTED = `${ABOUT}
This hosted server holds no keys and spends nothing. market shows a stock's price and the next open; quote_protection
prices protection (show the user the cost and what it pays before buying); protect_portfolio sizes protection to the
TSLAx and TSLAon a Solana wallet holds. To buy, protection_transaction or protect_portfolio returns an unsigned
transaction for the buyer's own wallet to sign (a fresh devnet wallet is sent test money first). positions follows any
wallet; vault shows the vault's collateral and every series; gap_report prices a whole book (a wallet, a vault, a lending
market's collateral) against each stock's worst openings and until the next open; kamino_loan finds the opening that
would make a wallet's Kamino loan liquidatable and prices protection down to it. An agent that should hold its own wallet and buy by itself
can run the local server from the Afterbell repo (agent/server.ts).`;

const LOCAL = `${ABOUT}
Typical flow: wallet, then get_test_funds the first time. market shows a stock's price and the next open;
quote_protection prices protection; show the user the cost and what it pays and get their agreement before
buy_protection, which spends from the agent's wallet up to its spending cap. protect_portfolio does the same sized to
what a mainnet wallet holds. positions follows the agent's protection; after the open settles, claim collects payouts
(a keeper also pays every position out). gap_report prices a whole book against each stock's worst openings;
kamino_loan finds the opening that would make a Kamino loan liquidatable and prices protection down to it.`;

export const read = { readOnlyHint: true, openWorldHint: true } as const;

const SOURCE: Record<PriceSource, string> = { pyth: "Pyth", chainlink: "Chainlink", hyperliquid: "Hyperliquid" };

const symbolArg = z.string().optional().describe("The stock, such as TSLA, QQQ or NVDA. Default TSLA; market lists them all.");

const protectionArgs = {
  symbol: symbolArg,
  shares: z.number().positive().optional().describe("Shares of the stock to protect."),
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
    `Protection for ${p.protection.shares} ${p.symbol} until ${nyTime(p.openTs)}: pay ${usd(p.premium)}.`,
    `If ${p.symbol} opens below ${usd(p.protection.upper)}, it pays ${usd(p.protection.shares)} for every dollar below, up to ${usd(p.maxPayout)} at ${usd(p.protection.lower)} or lower.`,
    `Chance it pays anything: ${(p.probabilityOfPayout * 100).toFixed(1)}% (from ${p.model.openings} past ${p.symbol} openings). Priced from ${usd(p.reference.price)} (${p.reference.basis}).`,
  ].join("\n");
}

/** A gap report as text: the book's totals, then a paragraph per stock. */
export function describeGapReport(r: GapReport & { names: Record<string, string> }): string {
  const t = r.totals;
  const openTs = r.lines.flatMap((l) => ("openTs" in l.tonight ? [l.tonight.openTs] : []))[0];
  const range = `from ${r.structure.deductible * 100}% to ${r.structure.depth * 100}% below each price`;
  const out = [
    `The book is worth ${usd(t.value)} across ${r.lines.length} stock${r.lines.length === 1 ? "" : "s"}.`,
    openTs ? `Protection ${range}, until ${nyTime(openTs)}, costs ${usd(t.premium)} and pays up to ${usd(t.maxPayout)}.` : `Protection can't be priced right now.`,
    `If every stock had its worst recorded opening at once, the book would lose ${usd(t.worstNightLoss)} and the protection would pay ${usd(t.worstNightPaid)} (a bound, not a forecast).`,
  ];
  for (const l of r.lines) {
    const down2 = l.history.downAtLeast.find((d) => d.move === 0.02)?.nights ?? 0;
    const tonight = "premium" in l.tonight ? `Protecting it costs ${usd(l.tonight.premium)} and pays up to ${usd(l.tonight.maxPayout)}.` : `Not priced now: ${l.tonight.unavailable}.`;
    const replay = l.replay ? ` Replayed on ${l.replay.nights} past openings it paid back ${Math.round(l.replay.paidPerDollar * 100)}¢ per $1 of premium and paid out on ${l.replay.paidNights} of them.` : "";
    out.push(
      `${l.symbol} (${r.names[l.symbol] ?? l.symbol}): ${Math.round(l.shares * 10_000) / 10_000} shares, ${usd(l.value)} at ${usd(l.reference.price)}. It opened 2% or more below its close on ${down2} of ${l.history.openings} openings since ${l.history.from}; the worst was ${(l.history.worst.gap * 100).toFixed(1)}% on ${l.history.worst.to}, which would cost this position ${usd(l.worstNight.loss)} today, of which the protection pays ${usd(l.worstNight.protectionPays)}. ${tonight}${replay}`,
    );
  }
  if (r.skipped.length) out.push(`Not in the report: ${r.skipped.map((s) => `${s.symbol} (${s.reason})`).join("; ")}.`);
  return out.join("\n");
}

/** A wallet's Kamino loans as text: for each, where it breaks, how often its stocks have gone that far, and the cover. */
export function describeLoans(r: KaminoLoansResponse): string {
  if (r.loans.length === 0) return `${r.wallet} has no loan against tokenized stocks in Kamino's markets.`;
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  return r.loans
    .map((loan) => {
      const { risk, band, report } = loan;
      const g = risk.together;
      const breaks =
        g === 0
          ? "It can be liquidated already: its debt is past the limit."
          : g === null
            ? "Its stocks can't make it liquidatable on their own."
            : `It becomes liquidatable if its stocks open ${pct(g)} below today's price together.`;
      const alone = risk.alone.filter((a) => a.gap !== null && a.gap > 0).map((a) => `${a.symbol} ${pct(a.gap!)}`);
      const history = report.lines.map((l) => {
        const n = g && g > 0 ? l.history.downAtLeast.find((d) => d.move === g)?.nights : undefined;
        const p = g && g > 0 && "chanceDown" in l.tonight ? l.tonight.chanceDown.find((d) => d.move === g)?.probability : undefined;
        const model = p === undefined ? "" : `, and the pricing model gives it ${p < 0.0001 ? "less than a 0.01%" : `a ${(p * 100).toFixed(2)}%`} chance of opening that far down tonight`;
        return `${l.symbol} has opened that far down on ${n ?? "none"} of ${l.history.openings} recorded openings (worst ${pct(l.history.worst.gap)} on ${l.history.worst.to})${model}`;
      });
      const t = report.totals;
      const openTs = report.lines.flatMap((l) => ("openTs" in l.tonight ? [l.tonight.openTs] : []))[0];
      const cover = openTs
        ? `Protection from ${band.start}% to ${band.stop}% below each price${band.toLiquidation ? ", down to where the loan becomes liquidatable," : ""} until ${nyTime(openTs)} costs ${usd(t.premium)} and pays up to ${usd(t.maxPayout)}. It pays after the open, from the oracle's price: it doesn't stop a liquidation, it pays back what the gap took.`
        : "Protection can't be priced right now.";
      return [
        `${loan.marketName} loan ${loan.obligation}: ${usd(loan.debtUsd)} borrowed against ${usd(loan.depositUsd)} of collateral (${loan.stocks.map((st) => `${st.symbol} ${usd(st.usd)}`).join(", ")}).`,
        `${breaks}${alone.length ? ` Each alone: ${alone.join(", ")}.` : ""}`,
        history.length ? `${history.join("; ")}.` : "",
        cover,
        report.skipped.length ? `Not priced: ${report.skipped.map((sk) => sk.symbol).join(", ")}.` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

/** How many shares: given, or the TSLA `holder` holds on mainnet (tokenized TSLA is all it can read). */
export async function sharesFor(api: AfterbellClient, shares: number | undefined, holder: string | undefined, symbol = "TSLA"): Promise<number> {
  if (shares !== undefined) return shares;
  if (!holder) throw new Error("Give shares, or holder (a Solana mainnet wallet) to size protection to what it holds.");
  if (symbol.toUpperCase() !== "TSLA") throw new Error(`Sizing to a wallet's holdings works for TSLA only; give shares of ${symbol}.`);
  const held = (await api.holdings(holder)).reduce((a, h) => a + h.shares, 0);
  if (!(held > 0)) throw new Error(`${holder} holds no TSLAx or TSLAon on mainnet.`);
  return held;
}

export type AgentWalletTools = {
  wallet(): Promise<string>;
  getTestFunds(): Promise<string>;
  buy(symbol: string, shares: number, startsBelow?: number, stopsBelow?: number, maxCost?: number): Promise<string>;
  claim(): Promise<string>;
  address(): string;
};

export function createServer(kind: "hosted" | "local", api: AfterbellClient, wallet?: AgentWalletTools): McpServer {
  const server = new McpServer({ name: "afterbell", version: "0.1.0" }, { instructions: kind === "local" ? LOCAL : HOSTED });

  server.registerTool(
    "market",
    {
      title: "A stock and the next open",
      description:
        "A stock's last close and live price, whether the exchange is open, the next 09:30 ET open protection settles on, whether protection is on sale and where, and every stock covered.",
      inputSchema: { symbol: symbolArg },
      annotations: read,
    },
    ({ symbol }) =>
      respond(async () => {
        const m = await api.market(symbol);
        const onSolana = m.stocks.filter((s) => s.solana).map((s) => s.symbol);
        return [
          `${m.symbol} (${m.name}) closed at ${usd(m.close)} (${nyTime(m.closeTs)}, ${SOURCE[m.closeSource]}).`,
          m.live !== null ? `Now ${usd(m.live)} on ${SOURCE[m.liveSource]}; the exchange is ${m.inSession ? "open" : "closed"}.` : "",
          `The next open protection settles on: ${nyTime(m.nextOpen)}.`,
          m.paused ? `Sales are paused: ${m.paused}.` : `Protection is priced from ${usd(m.reference!.price)} (${m.reference!.basis}).`,
          !m.solana ? "Solana devnet's vault v2 isn't deployed yet; it can be priced here." : m.solana.selling ? `On sale on Solana devnet.` : `Not on sale on Solana devnet, which sells ${onSolana.join(" and ")}; it can be priced here.`,
          `Stocks covered: ${m.stocks.map((s) => s.symbol).join(", ")}.`,
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
        "Prices protection on a stock until the next open: the premium, the most it pays, the chance it pays, and how the same protection did on every past opening of that stock. Spends nothing.",
      inputSchema: { ...protectionArgs, holder: z.string().optional().describe("TSLA only: a Solana mainnet wallet, to size protection to the TSLAx and TSLAon it holds.") },
      annotations: read,
    },
    ({ symbol, shares, holder, starts_below, stops_below }) =>
      respond(async () => {
        const m = await api.market(symbol);
        const p = priceQuote(Math.floor(Date.now() / 1000), toMarket(m), protectionFor(m, await sharesFor(api, shares, holder, m.symbol), starts_below, stops_below), m.config);
        const start = (starts_below ?? 2) / 100;
        const record = backtest(m.history, { deductible: start, depth: (stops_below ?? 10) / 100 }, { shares: 1, annualVol: m.annualVol, margin: m.config.margin, minRate: m.config.minRate });
        const toBuy = m.solana?.selling ? `To buy: ${kind === "local" ? "buy_protection" : "protection_transaction"} with the same arguments.` : `Solana devnet doesn't sell ${m.symbol}; this is a price only.`;
        return `${describe(p)}\nReplayed on ${record.nights.length} past ${m.symbol} openings, each priced only from the ones before it, this protection paid back ${Math.round(record.paidPerDollar * 100)}¢ per $1 of premium and paid out on ${record.paidNights} of them.\n${toBuy}`;
      }),
  );

  server.registerTool(
    "gap_report",
    {
      title: "Gap report for a book",
      description:
        "For a book of stock holdings (a wallet, a vault, a lending market's collateral): how each stock has opened after its closes, what its worst recorded opening would cost the book at today's price and what protection would pay that night, and what protecting the whole book until the next open costs now. Prices only; spends nothing.",
      inputSchema: {
        book: z
          .array(z.object({ symbol: z.string(), shares: z.number().positive().optional(), dollars: z.number().positive().optional() }))
          .optional()
          .describe("Holdings, each as shares or as a dollar value."),
        holder: z.string().optional().describe("A Solana mainnet wallet, to add the TSLAx and TSLAon it holds."),
        starts_below: protectionArgs.starts_below,
        stops_below: protectionArgs.stops_below,
      },
      annotations: read,
    },
    ({ book, holder, starts_below, stops_below }) =>
      respond(async () => {
        const lines = (book ?? []).map((l) => {
          if ((l.shares === undefined) === (l.dollars === undefined)) throw new Error(`Give ${l.symbol} as shares or as dollars, not both or neither.`);
          return l.shares !== undefined ? { symbol: l.symbol, shares: l.shares } : { symbol: l.symbol, value: l.dollars };
        });
        const r = await api.gapReport({ book: lines.length ? formatBook(lines) : undefined, owner: holder, start: starts_below ?? 2, stop: stops_below ?? 10 });
        return describeGapReport(r);
      }),
  );

  server.registerTool(
    "kamino_loan",
    {
      title: "Where a Kamino loan breaks, and cover down to it",
      description:
        "A Solana wallet's loans against tokenized stocks on Kamino, read from Kamino's public API: for each, how far its stocks can open below today's price before it can be liquidated (together, and each alone), how many recorded openings went that far, and protection until the next open from 2% below down to exactly that price. Prices only; spends nothing.",
      inputSchema: { wallet: z.string().describe("A Solana wallet that borrows on Kamino.") },
      annotations: read,
    },
    ({ wallet: owner }) => respond(async () => describeLoans(await api.kaminoLoans(owner))),
  );

  server.registerTool(
    "positions",
    {
      title: "Protection held",
      description: "The protection a wallet holds that hasn't been paid out yet (each position is an NFT; whoever holds it is paid): what it covers, what it cost, and once the open has settled, what it pays.",
      inputSchema: { owner: z.string().optional().describe(kind === "local" ? "A Solana wallet. Default: the agent's." : "A Solana wallet.") },
      annotations: read,
    },
    ({ owner }) =>
      respond(async () => {
        const who = owner ?? wallet?.address();
        if (!who) throw new Error("Give owner, a Solana wallet.");
        const ps = await api.positions(who);
        if (ps.length === 0) return `${who} holds no protection that hasn't been paid out.`;
        return ps
          .map((p) => {
            const status = p.state === "open" ? `open until ${nyTime(p.openTs)}` : p.state === "voided" ? `voided: claim refunds ${usd(p.claimable ?? 0)}` : `opened at ${usd(p.settlementPrice ?? 0)}: claim pays ${usd(p.claimable ?? 0)}`;
            return `${p.shares} ${p.symbol} protected from ${usd(p.upper)} to ${usd(p.lower)}, paid ${usd(p.premium)}, pays up to ${usd(p.maxPayout)}; ${status}.`;
          })
          .join("\n");
      }),
  );

  server.registerTool(
    "vault",
    {
      title: "The vault",
      description: "The vault's collateral, what's locked for open protection, its underwriters' pool, and every series with how it settled (its track record).",
      inputSchema: {},
      annotations: read,
    },
    () =>
      respond(async () => {
        const v = await api.vault();
        const lines = v.series.map((s) => `${s.symbol}, ${nyTime(s.openTs)}: ${s.state === "settled" ? `settled at ${usd(s.price ?? 0)}` : s.state}, ${s.positions} positions sold, ${usd(s.premiums)} in premiums`);
        const pool = v.pool && `The pool is worth ${usd(v.pool.nav)} (${usd(v.pool.sharePrice)} a share), and this round can sell ${usd(v.pool.room)} more in maximum payouts.`;
        return [`Collateral ${usd(v.collateral)} TestUSD, ${usd(v.locked)} locked for open protection (every sale locks its maximum payout).`, pool, ...lines].filter(Boolean).join("\n");
      }),
  );

  if (kind === "hosted") {
    const transactionFor = async (buyer: string, symbol: string | undefined, shares: number, startsBelow?: number, stopsBelow?: number) => {
      const owner = new PublicKey(buyer);
      const m = await api.market(symbol);
      const r = await api.quote({ chain: "solana", symbol: m.symbol, buyer, ...protectionFor(m, shares, startsBelow, stopsBelow) });
      const connection = new Connection(SOLANA_RPC, "confirmed");
      // A fresh devnet wallet gets test money first, so it can pay.
      const funded = await api.faucet(buyer).catch(() => null);
      const { transaction: tx } = await solanaPurchase(connection, owner, r.solana);
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
      ({ buyer, symbol, shares, starts_below, stops_below }) =>
        respond(async () => {
          if (shares === undefined) throw new Error("Give shares, or use protect_portfolio to size protection to a wallet's holdings.");
          return transactionFor(buyer, symbol, shares, starts_below, stops_below);
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
      ({ holder, buyer, starts_below, stops_below }) => respond(async () => transactionFor(buyer ?? holder, "TSLA", await sharesFor(api, undefined, holder), starts_below, stops_below)),
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
      ({ symbol, shares, starts_below, stops_below, max_cost }) =>
        respond(async () => {
          if (shares === undefined) throw new Error("Give shares, or use protect_portfolio.");
          return wallet.buy(symbol ?? "TSLA", shares, starts_below, stops_below, max_cost);
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
      ({ holder, starts_below, stops_below, max_cost }) => respond(async () => wallet.buy("TSLA", await sharesFor(api, undefined, holder), starts_below, stops_below, max_cost)),
    );
    server.registerTool(
      "claim",
      { title: "Claim", description: "Claims every settled or voided protection the agent holds, paying out (or refunding) into its wallet.", inputSchema: {}, annotations: { openWorldHint: true } },
      () => respond(() => wallet.claim()),
    );
  }
  return server;
}
