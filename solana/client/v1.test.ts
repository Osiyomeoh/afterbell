import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import idl from "./idl/v1/afterbell_vault.json" with { type: "json" };
import {
  feedConfigAddress,
  feedIdBytes,
  positionAddress,
  PROGRAM_ID,
  seriesAddress,
  TSLA_FEED_ID,
  vaultAddress,
  vaultTokenAddress,
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
});
