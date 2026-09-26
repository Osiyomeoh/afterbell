import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Connection, type ParsedAccountData, PublicKey } from "@solana/web3.js";

/** Tokenized stocks live on mainnet; the vault is on devnet. */
const MAINNET_RPC = process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";

/** TSLA's tokenized versions on Solana (Token-2022). */
export const TSLA_TOKENS = [
  { symbol: "TSLAx", issuer: "xStocks", mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB" },
  { symbol: "TSLAon", issuer: "Ondo", mint: "KeGv7bsfR4MheC1CkmnAVceoApjrkvBhHYjWb67ondo" },
];

type ScaledUiAmount = { multiplier: string; newMultiplier: string; newMultiplierEffectiveTimestamp: number };

/**
 * xStocks and Ondo pass dividends through by raising a Token-2022 UI
 * multiplier rather than minting, so the raw balance understates the shares
 * held (ported from Weekend Markets).
 */
function multiplierOf(mint: ParsedAccountData | undefined, now: number): number {
  const exts = (mint?.parsed?.info?.extensions ?? []) as { extension: string; state: unknown }[];
  const cfg = exts.find((e) => e.extension === "scaledUiAmountConfig")?.state as ScaledUiAmount | undefined;
  if (!cfg) return 1;
  const m = Number(now >= cfg.newMultiplierEffectiveTimestamp ? cfg.newMultiplier : cfg.multiplier);
  return Number.isFinite(m) && m > 0 ? m : 1;
}

/** TSLA share-equivalents `owner` holds on mainnet, per token. Read-only. */
export async function tslaHoldings(owner: PublicKey): Promise<{ symbol: string; shares: number }[]> {
  const connection = new Connection(MAINNET_RPC, "confirmed");
  const mints = new Map(TSLA_TOKENS.map((t) => [t.mint, t.symbol]));
  const { value } = await connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID });
  const raw = new Map<string, { amount: bigint; decimals: number }>();
  for (const { account } of value) {
    const info = account.data.parsed.info as { mint: string; tokenAmount: { amount: string; decimals: number } };
    if (!mints.has(info.mint)) continue;
    raw.set(info.mint, { amount: (raw.get(info.mint)?.amount ?? 0n) + BigInt(info.tokenAmount.amount), decimals: info.tokenAmount.decimals });
  }
  const held = [...raw].filter(([, b]) => b.amount > 0n);
  if (held.length === 0) return [];
  const accounts = await connection.getMultipleParsedAccounts(held.map(([m]) => new PublicKey(m)));
  const now = Math.floor(Date.now() / 1000);
  return held.map(([mint, b], i) => {
    const data = accounts.value[i]?.data;
    return { symbol: mints.get(mint)!, shares: (Number(b.amount) / 10 ** b.decimals) * multiplierOf(data && "parsed" in data ? data : undefined, now) };
  });
}
