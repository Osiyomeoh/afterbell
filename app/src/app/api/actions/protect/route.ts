import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

import { DEFAULT_QUOTER_CONFIG } from "@root/quoter/quoter";

import { nyTime, usd } from "@/lib/format";
import { SOLANA_DEPLOYMENT } from "@/server/deployment";
import { keypairFromEnv } from "@/server/env";
import { drip } from "@/server/faucet";
import { tslaHoldings } from "@/server/holdings";
import { OfferError, protectionBelow, purchaseTransaction, signedOffer, type SignedOffer } from "@/server/offer";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Protection as a Solana Action (a Blink): GET describes it with a live
 * price, POST returns a transaction any wallet, or any agent with a wallet,
 * can sign. The Blink sells one shape, protection from 2% to 10% below the
 * price, and a fresh devnet wallet is sent test money first, so one click
 * works from nothing.
 */

const START = 0.02;
const DEPTH = 0.1;
const EXAMPLE_SHARES = 10;
const MAX_SHARES = DEFAULT_QUOTER_CONFIG.maxShares;
// A wallet takes longer to show and sign an Action than our own page does.
const ACTION_CONFIG = { ...DEFAULT_QUOTER_CONFIG, ttlSecs: 120 };
const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const RPC = process.env.SOLANA_RPC || process.env.NEXT_PUBLIC_SOLANA_RPC || "https://api.devnet.solana.com";

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Accept-Action-Version, X-Accept-Blockchain-Ids",
  "Access-Control-Expose-Headers": "X-Action-Version, X-Blockchain-Ids",
  "X-Action-Version": "2.4",
  "X-Blockchain-Ids": DEVNET,
};

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });

function summary(o: SignedOffer): string {
  const p = o.priced;
  return (
    `Protection for ${p.protection.shares} TSLA until ${nyTime(p.openTs)} costs ${usd(p.premium)} and pays up to ${usd(p.maxPayout)} ` +
    `if TSLA opens below ${usd(p.protection.upper)}.`
  );
}

export async function OPTIONS() {
  return new Response(null, { headers: HEADERS });
}

export async function GET(request: Request) {
  const base = new URL(request.url).origin;
  const actions = [
    { type: "transaction", label: "Protect what I hold", href: "/api/actions/protect?shares=held" },
    { type: "transaction", label: `Protect ${EXAMPLE_SHARES} TSLA`, href: `/api/actions/protect?shares=${EXAMPLE_SHARES}` },
    {
      type: "transaction",
      label: "Protect",
      href: "/api/actions/protect?shares={shares}",
      parameters: [{ type: "number", name: "shares", label: "Shares of TSLA", required: true, min: 0.01, max: MAX_SHARES }],
    },
  ];
  const common = { type: "action", icon: `${base}/opengraph-image`, title: "Protect TSLA until the opening bell", label: "Protect" };
  try {
    const example = await signedOffer(PublicKey.default, await protectionBelow(EXAMPLE_SHARES, START, DEPTH), ACTION_CONFIG);
    return json({
      ...common,
      description:
        `${summary(example)} Covers the fall from 2% to 10% below today's price, settled on-chain by the first Pyth price after 09:30 ET. ` +
        `"Protect what I hold" reads your TSLAx and TSLAon on mainnet. Solana devnet with TestUSD: a new wallet gets test money first.`,
      links: { actions },
    });
  } catch (e) {
    return json({ ...common, description: e instanceof OfferError ? `Sales are paused: ${e.message}.` : "Quotes are unavailable right now.", disabled: true, links: { actions } });
  }
}

export async function POST(request: Request) {
  let owner: PublicKey;
  try {
    const body = (await request.json()) as { account?: unknown };
    owner = new PublicKey(String(body.account));
    if (!PublicKey.isOnCurve(owner.toBytes())) throw new Error();
  } catch {
    return json({ message: "account must be a wallet address" }, 400);
  }

  const connection = new Connection(RPC, "confirmed");
  try {
    const param = new URL(request.url).searchParams.get("shares") ?? "";
    let shares: number;
    if (param === "held") {
      shares = (await tslaHoldings(owner)).reduce((a, h) => a + h.shares, 0);
      if (!(shares > 0)) throw new OfferError("This wallet holds no TSLAx or TSLAon on mainnet. Enter a number of shares.");
    } else {
      shares = Number(param);
      if (!(shares > 0 && shares <= MAX_SHARES)) throw new OfferError(`Enter between 0.01 and ${MAX_SHARES} shares.`);
    }
    shares = Math.min(Math.round(shares * 10_000) / 10_000, MAX_SHARES);

    const offer = await signedOffer(owner, await protectionBelow(shares, START, DEPTH), ACTION_CONFIG);

    // One click from nothing: fund a fresh devnet wallet before handing it the transaction.
    const mint = new PublicKey(SOLANA_DEPLOYMENT.collateralMint);
    const [balance, lamports] = await Promise.all([
      connection.getTokenAccountBalance(getAssociatedTokenAddressSync(mint, owner)).then((b) => BigInt(b.value.amount), () => 0n),
      connection.getBalance(owner),
    ]);
    let funded = "";
    const premium = offer.signed.quote.premium;
    if (balance < premium || lamports < 0.01 * LAMPORTS_PER_SOL) {
      const faucet = keypairFromEnv("FAUCET_SOLANA_KEY");
      if (faucet) {
        const r = await drip(connection, faucet, mint, owner);
        if (r.testUsd > 0) funded = `Sent you ${r.testUsd.toLocaleString()} TestUSD first. `;
        else if (r.sol > 0) funded = "Sent you devnet SOL for fees first. ";
        if (balance + BigInt(r.testUsd) * 1_000_000n < premium) {
          throw new OfferError(`That costs ${usd(offer.priced.premium)}; this wallet has less TestUSD than that. Try fewer shares.`);
        }
      } else if (balance < premium) {
        throw new OfferError("This wallet needs TestUSD to pay the premium.");
      }
    }

    const tx = await purchaseTransaction(connection, owner, offer);
    return json({
      type: "transaction",
      transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
      message: `${funded}${summary(offer)}`,
    });
  } catch (e) {
    if (e instanceof OfferError) return json({ message: e.message }, 422);
    return json({ message: (e as Error).message }, 500);
  }
}
