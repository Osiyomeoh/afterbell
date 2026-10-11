/**
 * Kamino's xStocks market on a local validator: its lending and farms
 * programs, the TSLAx and USDC reserves and the accounts they read, copied
 * from mainnet (read-only) at startup. Two edits make it usable locally:
 *
 * - TSLAx's and USDC's mint authority is a local key, so a test can mint
 *   collateral to deposit and dollars to repay with.
 * - Scope's prices for the two reserves are stamped later than they were
 *   read, so they stay within Kamino's maximum price age (180 s for USDC)
 *   while a test runs. The prices themselves are mainnet's.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PublicKey } from "@solana/web3.js";

import { USDC_MINT, USDC_RESERVE, XSTOCKS_MARKET } from "../client/kamino";

export { USDC_MINT, USDC_RESERVE, XSTOCKS_MARKET };

export const KLEND = new PublicKey(
  "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
);
export const FARMS = new PublicKey(
  "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr",
);
export const TSLAX_RESERVE = new PublicKey(
  "5iTiczqgUegqA3PpoNpotizMbY9n1sRWr3oL6igKvWuf",
);
export const TSLAX_MINT = new PublicKey(
  "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
);
const SCOPE_PRICES = new PublicKey(
  "3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH",
);
/** The Scope entries the two reserves read: TSLAx price and TWAP, USDC price and TWAP. */
const SCOPE_INDEXES = [338, 273, 13, 456];

/** Each reserve's vaults, collateral mint and debt farm, as its account on mainnet names them. */
const RESERVE_ACCOUNTS = [
  // TSLAx: liquidity supply, collateral supply, collateral mint, fee vault
  "AvhRUjab47DCo9efnzmDha8xUeQFEs36Yywv1x8t3T2W",
  "5nFXkYBqkEmKZHFabSiiyjX2XVxUT9jfuUkLFoVTvVk5",
  "6bZpUNY1qmbvQBgCmfQJUA377X63ATvnpCHYh8hQnfjC",
  "BBjnJAbKBrA6dfoxB51fa14Pqet6ZRZBU9ai2skU3U3o",
  // USDC: liquidity supply, collateral supply, collateral mint, fee vault, debt farm
  "72Gz8BM8vDr5zdeHmFB5A2ptNZYfVgDuw5LDkNwGDdTA",
  "DWSGoajpT2X7TmnW2uCtfUoKEy8CPoBYnu94ntrpjk44",
  "69nwLK2t639e2c2ZWmZAbs2HWKZwG4pXVPzBTiEtNmwf",
  "DPHXY8LbH4cPPAgBDNnrU7B2XwmhWcBZ9wTBi3uZpfh4",
  "82eHAjSXZEyA3UpBxTjVYXF4QJmAEtLR6kvWXQca7mqd",
].map((k) => new PublicKey(k));
/** Where a Reserve's last-update slot sits: after the discriminator and its version. */
const RESERVE_LAST_UPDATE_SLOT_AT = 8 + 8;
/** Where a farm's global config sits in its FarmState: after the discriminator and the farm admin. */
const FARM_GLOBAL_CONFIG_AT = 8 + 32;

/**
 * A saved copy of everything kaminoFork reads from mainnet (kamino-snapshot.ts),
 * so the replay runs with no RPC. KAMINO_FROM_MAINNET=1 reads mainnet instead.
 */
export const SNAPSHOT_DIR = "solana/fixtures/kamino";
const SNAPSHOT = join(SNAPSHOT_DIR, "accounts.json");
const programFile = (p: PublicKey) => join(SNAPSHOT_DIR, `${p.toBase58()}.so`);
const useSnapshot = () => !process.env.KAMINO_FROM_MAINNET && existsSync(SNAPSHOT);

const MAINNET =
  process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";

type Raw = {
  data: [string, "base64"];
  owner: string;
  lamports: number;
  executable: boolean;
  rentEpoch: number;
  space: number;
};

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(MAINNET, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      result?: T;
      error?: { message: string };
    };
    if (body.result !== undefined) return body.result;
    if (attempt === 4)
      throw new Error(`${method}: ${body.error?.message ?? res.status}`);
    await new Promise((r) => setTimeout(r, 1_500 * (attempt + 1)));
  }
}

async function fetchAccounts(keys: PublicKey[]): Promise<Map<string, Raw>> {
  const { value } = await rpc<{ value: (Omit<Raw, "space"> | null)[] }>(
    "getMultipleAccounts",
    [keys.map((k) => k.toBase58()), { encoding: "base64" }],
  );
  const out = new Map<string, Raw>();
  value.forEach((a, i) => {
    if (!a) throw new Error(`${keys[i]!.toBase58()} isn't on mainnet`);
    out.set(keys[i]!.toBase58(), {
      ...a,
      rentEpoch: 0,
      space: Buffer.from(a.data[0], "base64").length,
    });
  });
  return out;
}

const edit = (a: Raw, f: (data: Buffer) => void) => {
  const data = Buffer.from(a.data[0], "base64");
  f(data);
  a.data = [data.toString("base64"), "base64"];
};

/** Every account the fork loads, as mainnet has it: the market, reserves, mints, Scope and farm configs. */
async function mainnetAccounts(): Promise<Map<string, Raw>> {
  const accounts = await fetchAccounts([
    XSTOCKS_MARKET,
    TSLAX_RESERVE,
    USDC_RESERVE,
    TSLAX_MINT,
    USDC_MINT,
    SCOPE_PRICES,
    ...RESERVE_ACCOUNTS,
  ]);
  for (const a of [...accounts.values()].filter(
    (a) => a.owner === FARMS.toBase58(),
  )) {
    const config = new PublicKey(
      Buffer.from(a.data[0], "base64").subarray(
        FARM_GLOBAL_CONFIG_AT,
        FARM_GLOBAL_CONFIG_AT + 32,
      ),
    );
    for (const [k, v] of await fetchAccounts([config])) accounts.set(k, v);
  }
  return accounts;
}

/** A program's executable as deployed: its ProgramData account, less the 45-byte header. */
async function mainnetProgram(program: PublicKey): Promise<Buffer> {
  const [account] = (await fetchAccounts([program])).values();
  const programData = new PublicKey(Buffer.from(account!.data[0], "base64").subarray(4, 36));
  const [data] = (await fetchAccounts([programData])).values();
  const elf = Buffer.from(data!.data[0], "base64").subarray(45);
  // The account is padded to its maximum size; the ELF ends with its section headers.
  const end = Number(elf.readBigUInt64LE(0x28)) + elf.readUInt16LE(0x3a) * elf.readUInt16LE(0x3c);
  return elf.subarray(0, end);
}

/** Saves the market's accounts and Kamino's two programs, read from mainnet now, for runs without an RPC. */
export async function snapshotKamino(): Promise<{ accounts: number; slot: number }> {
  const accounts = await mainnetAccounts();
  const slot = await rpc<number>("getSlot", [{ commitment: "confirmed" }]);
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  writeFileSync(SNAPSHOT, JSON.stringify({ slot, readAt: new Date().toISOString(), accounts: Object.fromEntries(accounts) }, null, 1) + "\n");
  for (const p of [KLEND, FARMS]) writeFileSync(programFile(p), await mainnetProgram(p));
  return { accounts: accounts.size, slot };
}

/**
 * Writes the accounts into `dir` and returns the validator arguments that load
 * them, with `mintAuthority` able to mint TSLAx and USDC. Scope's prices are
 * stamped `freshUntil`: when the test last needs them. Reads the saved
 * snapshot when there is one, else mainnet.
 */
export async function kaminoFork(
  dir: string,
  freshUntil: number,
  mintAuthority: PublicKey,
): Promise<string[]> {
  const offline = useSnapshot();
  if (offline) {
    const { slot, readAt } = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as { slot: number; readAt: string };
    console.log(`Kamino's xStocks market from ${SNAPSHOT_DIR}, read from mainnet at slot ${slot} (${readAt.slice(0, 10)}); no RPC needed`);
  }
  const accounts = offline
    ? new Map(Object.entries((JSON.parse(readFileSync(SNAPSHOT, "utf8")) as { accounts: Record<string, Raw> }).accounts))
    : await mainnetAccounts();

  for (const mint of [TSLAX_MINT, USDC_MINT]) {
    edit(accounts.get(mint.toBase58())!, (d) => {
      d.writeUInt32LE(1, 0);
      mintAuthority.toBuffer().copy(d, 4);
    });
  }
  // A local chain starts at slot 0, behind mainnet. Kamino counts slots since each reserve's last
  // update, so those start at 0 too (accruing a few slots' interest, not mainnet's), and Scope's
  // prices read as fresh until `freshUntil`.
  for (const reserve of [TSLAX_RESERVE, USDC_RESERVE])
    edit(accounts.get(reserve.toBase58())!, (d) =>
      d.writeBigUInt64LE(0n, RESERVE_LAST_UPDATE_SLOT_AT),
    );
  // Scope's OraclePrices: discriminator, oracle mappings, then 56-byte dated prices (price 16, slot 8, unix time 8, …).
  edit(accounts.get(SCOPE_PRICES.toBase58())!, (d) => {
    for (const i of SCOPE_INDEXES) {
      d.writeBigUInt64LE(0n, 8 + 32 + 56 * i + 16);
      d.writeBigUInt64LE(BigInt(freshUntil), 8 + 32 + 56 * i + 24);
    }
  });

  const args = offline
    ? [KLEND, FARMS].flatMap((p) => ["--bpf-program", p.toBase58(), programFile(p)])
    : ["--url", "mainnet-beta", "--clone-upgradeable-program", KLEND.toBase58(), "--clone-upgradeable-program", FARMS.toBase58()];
  for (const [key, account] of accounts) {
    const file = join(dir, `kamino-${key}.json`);
    writeFileSync(file, JSON.stringify({ pubkey: key, account }));
    args.push("--account", key, file);
  }
  return args;
}
