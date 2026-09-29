/**
 * Private protection, on Solana devnet with test money: a holder pays the premium in a confidential
 * transfer on Helius's Solana Rings, a desk buys the protection in its own name, and after the open
 * the desk pays the holder what the protection paid, privately again.
 *
 * What the chain shows: the holder moved a round amount of TestUSD into a private balance, and paid the
 * desk something; the desk bought protection. What it doesn't: how much the holder paid, what they
 * protected, or which of the desk's positions is theirs. The desk's book holds that link, so the holder
 * trusts the desk: this is a demo of the privacy, not of a trustless design.
 *
 *   pnpm desk buy --shares 1 [--symbol TSLA]      the holder pays, the desk buys; writes runs/<time>.json
 *   pnpm desk payout runs/<time>.json             after the open: the desk pays the holder
 *
 * Keys: HOLDER_KEYPAIR and DESK_KEYPAIR are paths to Solana CLI keypair files (`solana-keygen new -o …`).
 * They're read, never printed or written. `buy --throwaway` uses two new keys held in memory instead, so
 * nothing can pay out later. Test money comes from Afterbell's faucet (AFTERBELL_URL, the hosted app by
 * default), SOL for fees included. RPC: SOLANA_RPC, public devnet by default.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { address } from "@solana/kit";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import { feedIdBytes, seriesAddress, positionAddress } from "../solana/client/vault";
import { AfterbellClient } from "../sdk/client";
import { solanaPurchase } from "../sdk/solana";

import { fromUnits, owed, roundDeposit, type DeskEntry, type DeskRun } from "./book";
import { assetsFor, connect, deposit, party, payPrivately, privateAddressFromHex, privateAddressHex, privateWallet, type Party } from "./rings";

const API = new AfterbellClient(process.env.AFTERBELL_URL ?? "https://afterbell-nine.vercel.app");
const RPC = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";
const explorer = (tx: string) => `https://explorer.solana.com/tx/${tx}?cluster=devnet`;

/** The 32-byte seed from a Solana CLI keypair file. */
function seedFrom(path: string): Uint8Array {
  const bytes = JSON.parse(readFileSync(path.replace(/^~(?=\/)/, homedir()), "utf8")) as unknown;
  if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
    throw new Error(`${path} isn't a Solana keypair file`);
  }
  return Uint8Array.from(bytes.slice(0, 32));
}

function seeds(throwaway: boolean): { holder: Uint8Array; desk: Uint8Array } {
  if (throwaway) return { holder: randomBytes(32), desk: randomBytes(32) };
  const holder = process.env.HOLDER_KEYPAIR;
  const desk = process.env.DESK_KEYPAIR;
  if (!holder || !desk) throw new Error("set HOLDER_KEYPAIR and DESK_KEYPAIR to keypair files, or pass --throwaway");
  return { holder: seedFrom(holder), desk: seedFrom(desk) };
}

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function buy(): Promise<void> {
  const throwaway = process.argv.includes("--throwaway");
  const symbol = (arg("symbol") ?? "TSLA").toUpperCase();
  const shares = Number(arg("shares") ?? 1);
  const s = seeds(throwaway);
  const holder = party(s.holder);
  const desk = party(s.desk);
  const deskKey = Keypair.fromSeed(s.desk);
  s.holder.fill(0);
  s.desk.fill(0);

  const client = await connect(RPC);
  const connection = new Connection(RPC, "confirmed");
  const vault = await API.vault();
  const mint = address(vault.collateralMint);
  console.log(`holder ${holder.solana}\ndesk   ${desk.solana}`);

  // Test money for both, from Afterbell's faucet: TestUSD, and SOL for fees.
  await API.faucet(holder.solana);
  await API.faucet(desk.solana);
  const { assets, created } = await assetsFor(client, desk, mint);
  if (created) console.log(`TestUSD's private interface created: ${explorer(created)}`);

  // 1. The price: protection from 2% to 10% below, as the app sells it.
  const protection = await API.protectionBelow(symbol, shares, 0.02, 0.1);
  const indicated = await API.quote({ chain: "solana", symbol, buyer: desk.solana, ...protection });
  const premium = BigInt(indicated.solana.quote.premium);
  console.log(`${shares} ${symbol} from $${protection.upper} to $${protection.lower} until the open: $${fromUnits(premium)}`);

  // 2. The holder moves a round amount into a private balance: public, but it doesn't show the premium.
  const holderAccount = address(getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(holder.solana)).toBase58());
  const depositTx = await deposit(client, holder, mint, holderAccount, roundDeposit(premium));
  console.log(`holder deposit, ${fromUnits(roundDeposit(premium))} TestUSD in: ${explorer(depositTx)}`);

  // 3. The holder pays the premium to the desk: a confidential transfer, no token or amount on-chain.
  const premiumTx = await payPrivately(client, holder, desk.keypair.shieldedAddress(), mint, premium, assets);
  console.log(`premium, private: ${explorer(premiumTx)}`);

  // 4. The desk reads it from its private balance, the only place the amount appears.
  const received = (await privateWallet(client, desk, assets)).privateTransactions().find((t) => t.id.signature === premiumTx);
  if (!received || BigInt(received.amount) !== premium) throw new Error(`the desk can't see the premium in ${premiumTx}`);

  // 5. The desk buys the protection in its own name, with its own public TestUSD, on a fresh quote.
  const quote = await API.quote({ chain: "solana", symbol, buyer: desk.solana, ...protection });
  const { transaction } = await solanaPurchase(connection, deskKey.publicKey, quote.solana);
  transaction.sign(deskKey);
  const buyTx = await connection.sendRawTransaction(transaction.serialize());
  await connection.confirmTransaction(buyTx, "confirmed");
  console.log(`desk buys, public: ${explorer(buyTx)}`);

  const q = quote.solana.quote;
  const vaultKey = new PublicKey(quote.solana.vault);
  const entry: DeskEntry = {
    symbol,
    ...protection,
    openTs: Number(q.openTs),
    premium: fromUnits(premium),
    holder: privateAddressHex(holder),
    holderWallet: holder.solana,
    position: positionAddress(vaultKey, Buffer.from(q.nonce, "hex")).toBase58(),
    series: seriesAddress(vaultKey, feedIdBytes(q.feedId), BigInt(q.openTs)).toBase58(),
    txs: { deposit: depositTx, premium: premiumTx, buy: buyTx },
  };
  const record: DeskRun = { network: "devnet", ranAt: new Date().toISOString(), throwaway, desk: desk.solana, mint, entry };
  mkdirSync(join(import.meta.dirname, "runs"), { recursive: true });
  const file = join(import.meta.dirname, "runs", `${record.ranAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  console.log(`\nrecorded: ${file}${throwaway ? "\nthrowaway keys: nothing can pay out after the open" : ""}`);
}

async function payoutRun(file: string): Promise<void> {
  const record = JSON.parse(readFileSync(file, "utf8")) as DeskRun;
  const e = record.entry;
  if (record.throwaway) throw new Error("that run used throwaway keys: nothing can pay out");
  if (e.paid !== undefined) return console.log(`paid already: ${e.paid} TestUSD, ${e.txs.payout ? explorer(e.txs.payout) : "nothing to send"}`);
  const s = seeds(false);
  const desk = party(s.desk);
  const holder = party(s.holder);
  s.holder.fill(0);
  s.desk.fill(0);
  if (desk.solana !== record.desk) throw new Error("DESK_KEYPAIR isn't the desk that made this run");

  const series = (await API.record()).find((r) => r.series === e.series);
  if (!series) throw new Error(`series ${e.series} isn't in the track record yet`);
  const amount = owed(e, series);
  if (amount === null) return console.log(`series still open: it settles at the open, ${new Date(e.openTs * 1000).toISOString()}`);

  const client = await connect(RPC);
  const mint = address(record.mint);
  const { assets } = await assetsFor(client, desk, mint);
  let payoutTx: string | undefined;
  if (amount > 0n) {
    // The desk pays from a private float it tops up with round amounts, so no deposit matches a payout.
    const float = (await privateWallet(client, desk, assets)).balance(mint).amount;
    if (float < amount) {
      const deskAccount = address(getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(desk.solana)).toBase58());
      await deposit(client, desk, mint, deskAccount, roundDeposit(amount - float));
    }
    payoutTx = await payPrivately(client, desk, privateAddressFromHex(e.holder), mint, amount, assets);
    console.log(`payout, private: ${explorer(payoutTx)}`);
  }
  e.paid = fromUnits(amount);
  if (payoutTx) e.txs.payout = payoutTx;
  writeFileSync(file, JSON.stringify(record, null, 2) + "\n");

  // What the holder sees, and nobody else can: their own private history.
  for (const t of (await privateWallet(client, holder, assets)).privateTransactions()) {
    console.log(`holder's view: ${t.kind} ${t.direction} ${fromUnits(BigInt(t.amount))} TestUSD (${t.id.signature})`);
  }
  console.log(`settled at $${series.price ?? "(voided)"}: the holder is owed ${e.paid} TestUSD`);
}

const [command, file] = process.argv.slice(2);
if (command === "buy") await buy();
else if (command === "payout" && file) await payoutRun(file);
else throw new Error("usage: pnpm desk buy --shares 1 [--symbol TSLA] [--throwaway] | pnpm desk payout runs/<file>.json");
