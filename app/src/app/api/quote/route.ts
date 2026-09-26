import { PublicKey } from "@solana/web3.js";

import { SOLANA_DEPLOYMENT } from "@/server/deployment";
import { OfferError, signedOffer } from "@/server/offer";

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
  if (body.chain !== "solana") return bad("only the Solana vault is live; Robinhood Chain is coming");
  if (!finite(body.shares) || !finite(body.upper) || !finite(body.lower)) return bad("shares, upper and lower must be numbers");
  let buyer: PublicKey;
  try {
    buyer = new PublicKey(body.buyer ?? "");
  } catch {
    return bad("buyer must be a Solana address");
  }

  try {
    const { priced, signed } = await signedOffer(buyer, { shares: body.shares, upper: body.upper, lower: body.lower });
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
