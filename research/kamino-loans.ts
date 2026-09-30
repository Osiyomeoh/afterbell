/**
 * A snapshot of every loan against tokenized stocks in Kamino's three stock markets, for the liquidation
 * map on /kamino: how much debt becomes liquidatable if the stocks open down.
 *
 * 1. Every obligation in each market, from Solana mainnet (getProgramAccounts), reading only the bytes
 *    for its deposits' reserves and its first borrow's reserve: an obligation's deposits start at byte
 *    96, 136 bytes each, 8 of them, and its first borrow at byte 1208 (checked against Kamino's API).
 * 2. Kept: those that hold a tokenized stock and borrow something.
 * 3. Each of those from Kamino's API (/klend/loans/{obligation}): every deposit's value and liquidation
 *    threshold, and every borrow's value and borrow factor, at current prices. Four a second.
 *
 *   npx tsx research/kamino-loans.ts        writes research/data/kamino-loans.json
 *
 * The snapshot holds no addresses: a market, the debt, and each deposit's stock, value and threshold.
 */
import { writeFileSync } from "node:fs";

import bs58 from "bs58";

import { KAMINO_STOCK_MARKETS, stockOf } from "../app/src/lib/kamino";
import type { MapLoan } from "../app/src/lib/kaminoMap";

const RPC = process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const KLEND = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const API = "https://api.kamino.finance";
const OBLIGATION_SIZE = 3344;
const DEPOSITS_AT = 96;
const DEPOSIT_SIZE = 136;
const DEPOSITS = 8;
const FIRST_BORROW_AT = 1208;
const EMPTY = "11111111111111111111111111111111";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (!body.result) throw new Error(`${method}: ${body.error?.message ?? res.status}`);
  return body.result;
}

async function get<T>(path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`);
    if (res.ok) return (await res.json()) as T;
    if (res.status !== 429 || attempt === 4) throw new Error(`${path}: ${res.status}`);
    await sleep(2_000 * (attempt + 1));
  }
}

/** The obligations in `market` that hold one of `stockReserves` and borrow something. */
async function borrowersWithStock(market: string, stockReserves: Set<string>): Promise<string[]> {
  const accounts = await rpc<{ pubkey: string; account: { data: [string, string] } }[]>("getProgramAccounts", [
    KLEND,
    {
      encoding: "base64",
      dataSlice: { offset: DEPOSITS_AT, length: FIRST_BORROW_AT + 32 - DEPOSITS_AT },
      filters: [{ dataSize: OBLIGATION_SIZE }, { memcmp: { offset: 32, bytes: market } }],
    },
  ]);
  const at = (d: Buffer, offset: number) => bs58.encode(d.subarray(offset - DEPOSITS_AT, offset - DEPOSITS_AT + 32));
  return accounts
    .filter(({ account }) => {
      const d = Buffer.from(account.data[0], "base64");
      const deposits = Array.from({ length: DEPOSITS }, (_, i) => at(d, DEPOSITS_AT + i * DEPOSIT_SIZE));
      return deposits.some((r) => stockReserves.has(r)) && at(d, FIRST_BORROW_AT) !== EMPTY;
    })
    .map((a) => a.pubkey);
}

type LoanInfo = {
  loanInfo: {
    collateral: { deposits: { tokenName: string; tokenValue: string; liquidationLtv: number }[] };
    debt: { borrows: { tokenValue: string; borrowFactor: number }[] };
  };
};

const loans: MapLoan[] = [];
const counts: { market: string; obligations: number; read: number }[] = [];
for (const m of KAMINO_STOCK_MARKETS) {
  const reserves = await get<{ reserve: string; liquidityToken: string }[]>(`/kamino-market/${m.address}/reserves/metrics`);
  const stockReserves = new Set(reserves.filter((r) => stockOf(r.liquidityToken)).map((r) => r.reserve));
  const obligations = await borrowersWithStock(m.address, stockReserves);
  let read = 0;
  for (const o of obligations) {
    const { loanInfo } = await get<LoanInfo>(`/klend/loans/${o}`);
    await sleep(250);
    const debt = loanInfo.debt.borrows.reduce((t, b) => t + Number(b.tokenValue) * b.borrowFactor, 0);
    const deposits = loanInfo.collateral.deposits.map((d) => ({ symbol: stockOf(d.tokenName), value: Number(d.tokenValue), liquidationLtv: d.liquidationLtv }));
    if (debt < 1 || !deposits.some((d) => d.symbol && d.value >= 1)) continue;
    loans.push({ market: m.name, debt, deposits });
    read++;
  }
  counts.push({ market: m.name, obligations: obligations.length, read });
  console.log(`${m.name}: ${obligations.length} obligations borrow against a stock; ${read} with at least $1 of each`);
}

const file = new URL("./data/kamino-loans.json", import.meta.url);
writeFileSync(file, JSON.stringify({ readAt: Math.floor(Date.now() / 1000), counts, loans }, null, 1) + "\n");
console.log(`${loans.length} loans, $${Math.round(loans.reduce((t, l) => t + l.debt, 0)).toLocaleString("en-US")} of debt: ${file.pathname}`);
