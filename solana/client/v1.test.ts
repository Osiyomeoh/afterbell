import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import idl from "./idl/v1/afterbell_vault.json" with { type: "json" };
import {
  addV1Events,
  emptyV1Ledger,
  feedConfigAddress,
  feedIdBytes,
  positionAddress,
  PROGRAM_ID,
  seriesAddress,
  TSLA_FEED_ID,
  v1LedgerFromJson,
  v1LedgerToJson,
  vaultAddress,
  vaultTokenAddress,
  type VaultEvent,
} from "./v1";

describe("Solana vault v1 client", () => {
  // The same addresses solana/programs/afterbell-vault/src/constants.rs pins for the program.
  it("derives the addresses the program derives", () => {
    const vault = vaultAddress(new PublicKey(new Uint8Array(32).fill(1)), new PublicKey(new Uint8Array(32).fill(2)));
    const feed = feedIdBytes(TSLA_FEED_ID);
    expect(vault.toBase58()).toBe("4SNGem1v12XZkASk7QhYfP3GYDPFNBcjC9d5kHQGJnqW");
    expect(vaultTokenAddress(vault).toBase58()).toBe("5aFQv22J7Td3KSSmLRFGsCiVwmWpgwQMa1QrcGp1JZ34");
    expect(feedConfigAddress(vault, feed).toBase58()).toBe("5GeZKgS3pLT3maKqxmRExD2r9grFQ4NFDjVfi2k4DVC8");
    expect(seriesAddress(vault, feed, 1_790_343_000n).toBase58()).toBe("ta6rLUJrPAs4y72igr8yjmH7Yk7DfowMowVtj61epG9");
    expect(positionAddress(vault, new Uint8Array(32).fill(9)).toBase58()).toBe("8c8ZCLuP7sR42CNwBdWVkZmFJxUr41kTk12zjeZs7pqp");
  });

  it("uses the program id the program declares", () => {
    expect(PROGRAM_ID.toBase58()).toBe("6J5BHSf1yWup7SXae5xS2nzNUbtz7Bq3VpfJTtxr7Dsc");
    expect(idl.instructions.map((i) => i.name).sort()).toEqual(
      ["allow_feed", "buy", "claim", "deposit", "initialize_vault", "set_config", "settle", "void_series", "withdraw"],
    );
  });

  it("parses feed ids with or without 0x and rejects anything else", () => {
    expect(feedIdBytes(TSLA_FEED_ID.slice(2))).toEqual(feedIdBytes(TSLA_FEED_ID));
    expect(feedIdBytes(TSLA_FEED_ID)[0]).toBe(0x16);
    expect(() => feedIdBytes("0x1234")).toThrow("32-byte feed id");
  });

  it("keeps what the events say was sold, settled and paid, and survives a trip through JSON", () => {
    const vault = new PublicKey(new Uint8Array(32).fill(2));
    const [a, b] = [new PublicKey(new Uint8Array(32).fill(5)), new PublicKey(new Uint8Array(32).fill(6))];
    const feedId = [...feedIdBytes(TSLA_FEED_ID)];
    const series = seriesAddress(vault, Uint8Array.from(feedId), 1_790_602_200n);
    const bought = (position: PublicKey, premium: number): VaultEvent => ({
      name: "protectionBought",
      data: { position, buyer: position, feedId, openTs: 1_790_602_200, premium, maxPayout: premium * 10 },
    });
    const ledger = emptyV1Ledger();
    addV1Events(ledger, vault, "buy", [bought(a, 1_000_000), bought(b, 2_000_000)]);
    addV1Events(ledger, vault, "settle", [{ name: "seriesSettled", data: { series, price: 36_809_007_000, publishTime: 1_790_602_200 } }]);
    addV1Events(ledger, vault, "claims", [
      { name: "claimed", data: { position: a, buyer: a, amount: 0, refund: false } },
      { name: "claimed", data: { position: b, buyer: b, amount: 2_229_930, refund: false } },
    ]);

    expect(ledger.through).toBe("claims");
    expect(ledger.bought.get(b.toBase58())).toEqual({ series: series.toBase58(), premium: 2_000_000n, maxPayout: 20_000_000n });
    expect(ledger.settleTx.get(series.toBase58())).toBe("settle");
    expect([...ledger.paid.values()]).toEqual([0n, 2_229_930n]);
    const json = JSON.parse(JSON.stringify(v1LedgerToJson(vault, ledger)));
    expect(json.vault).toBe(vault.toBase58());
    expect(v1LedgerFromJson(json)).toEqual(ledger);
  });
});
