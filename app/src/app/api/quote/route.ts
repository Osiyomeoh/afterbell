import { PublicKey } from "@solana/web3.js";

import { isAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { signForEvm } from "@root/quoter/quoter";

import { SOLANA_DEPLOYMENT } from "@/server/deployment";
import { evmDeployment } from "@/server/evmDeployment";
import { OfferError, priceOffer, signedOffer } from "@/server/offer";

export const dynamic = "force-dynamic";

type Body = { chain?: string; buyer?: string; shares?: number; upper?: number; lower?: number };

const bad = (error: string, status = 400) => Response.json({ error }, { status });
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Prices protection with the server's own market data (never the browser's)
 * and signs it for the buyer, who submits it to the vault within the quote's
 * lifetime.
 */
export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return bad("expected a JSON body");
  }
  if (!finite(body.shares) || !finite(body.upper) || !finite(body.lower)) return bad("shares, upper and lower must be numbers");
  const protection = { shares: body.shares, upper: body.upper, lower: body.lower };
  if (body.chain === "robinhood") return robinhoodQuote(body.buyer, protection);
  if (body.chain !== "solana") return bad("chain must be solana or robinhood");
  let buyer: PublicKey;
  try {
    buyer = new PublicKey(body.buyer ?? "");
  } catch {
    return bad("buyer must be a Solana address");
  }

  try {
    const { priced, signed } = await signedOffer(buyer, protection);
    const d = SOLANA_DEPLOYMENT;
    const q = signed.quote;
    return Response.json({
      priced,
      solana: {
        programId: d.programId,
        vault: d.vault,
        collateralMint: d.collateralMint,
        quoter: signed.quoter,
        quote: {
          feedId: Buffer.from(q.feedId).toString("hex"),
          openTs: q.openTs.toString(),
          shares: q.shares.toString(),
          upper: q.upper.toString(),
          lower: q.lower.toString(),
          premium: q.premium.toString(),
          expiry: q.expiry.toString(),
          nonce: Buffer.from(q.nonce).toString("hex"),
        },
        ed25519Data: Buffer.from(signed.ed25519Data).toString("base64"),
      },
    });
  } catch (e) {
    return bad((e as Error).message, e instanceof OfferError ? 422 : 503);
  }
}

/** The same protection, signed as EIP-712 typed data for the Robinhood Chain vault. */
async function robinhoodQuote(buyer: string | undefined, protection: { shares: number; upper: number; lower: number }) {
  const d = evmDeployment();
  if (!d) return bad("the Robinhood Chain vault isn't deployed yet", 503);
  if (!buyer || !isAddress(buyer)) return bad("buyer must be an EVM address");
  const key = process.env.QUOTER_EVM_KEY as Hex | undefined;
  if (!key) return bad("the quote service has no Robinhood Chain quoter key configured", 503);
  if (privateKeyToAccount(key).address.toLowerCase() !== d.quoter.toLowerCase()) return bad("the configured quoter key isn't this vault's quoter", 503);
  try {
    const priced = await priceOffer(protection);
    const { quote, signature } = await signForEvm(priced, buyer, { chainId: d.chainId, vault: d.vault, feed: d.feeds.TSLA }, key);
    return Response.json({
      priced,
      evm: {
        chainId: d.chainId,
        vault: d.vault,
        testUsd: d.testUsd,
        quoter: d.quoter,
        quote: Object.fromEntries(Object.entries(quote).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
        signature,
      },
    });
  } catch (e) {
    return bad((e as Error).message, e instanceof OfferError ? 422 : 503);
  }
}
