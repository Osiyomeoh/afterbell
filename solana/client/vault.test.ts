import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import idl from "./idl/afterbell_vault.json" with { type: "json" };
import {
  feedConfigAddress,
  feedIdBytes,
  pendingRate,
  positionAddress,
  positionMintAddress,
  PROGRAM_ID,
  rateAddress,
  requestAddress,
  seriesAddress,
  shareEscrowAddress,
  shareMintAddress,
  TSLA_FEED_ID,
  vaultAddress,
  vaultTokenAddress,
} from "./vault";

describe("Solana vault client", () => {
  // The same addresses, in the same order, as PINNED in
  // solana/programs/afterbell-vault/src/constants.rs: both change with the program id.
  it("derives the addresses the program derives", () => {
    const authority = new PublicKey(new Uint8Array(32).fill(1));
    const vault = vaultAddress(authority, new PublicKey(new Uint8Array(32).fill(2)));
    const feed = new Uint8Array(32).fill(7);
    const nonce = new Uint8Array(32).fill(9);
    const all = [
      vault,
      vaultTokenAddress(vault),
      shareMintAddress(vault),
      shareEscrowAddress(vault),
      feedConfigAddress(vault, feed),
      seriesAddress(vault, feed, 1_790_343_000n),
      positionAddress(vault, nonce),
      positionMintAddress(vault, nonce),
      requestAddress(vault, authority),
      rateAddress(vault, 1n),
    ].map((a) => a.toBase58());
    expect(all).toEqual([
      "4SNGem1v12XZkASk7QhYfP3GYDPFNBcjC9d5kHQGJnqW",
      "5aFQv22J7Td3KSSmLRFGsCiVwmWpgwQMa1QrcGp1JZ34",
      "8mu5FxnH7yoyexe73RgdrA8DyWY55Vhoeho3AVaV71By",
      "7PAosiVEmy5TRjMAj1mBWjkuVjVrwGRcyuCZ2bbCMzTh",
      "EEMXtkpgeZZzH6SZRk9Yy2U9iF5A8gqKLzqT6SKXssX1",
      "GMp3zVa9vyGk2Kj3dvvbQWki753SEfeTCgjRwdHsRQVU",
      "8c8ZCLuP7sR42CNwBdWVkZmFJxUr41kTk12zjeZs7pqp",
      "29TV96XxMEvQjUcAPH7s33y2y5ti5g8cXfGh9mYbi8s6",
      "J6TKLcwBUXyof4WbpQwWYH2hiDh34QW9ZqmNV3NPcYPf",
      "BmLtxAyVtYptUHXmD9XS72C5D65E8vhgzJ5TrndGPsdg",
    ]);
  });

  it("uses the program id the IDL declares, with v2's instructions", () => {
    expect(PROGRAM_ID.toBase58()).toBe(idl.address);
    expect(idl.instructions.map((i) => i.name).sort()).toEqual([
      "allow_feed",
      "buy",
      "claim_deposit",
      "claim_redemption",
      "initialize_vault",
      "process",
      "request_deposit",
      "request_redeem",
      "roll",
      "set_art_uri",
      "set_params",
      "set_quoter",
      "settle",
      "void_series",
    ]);
  });

  it("passes a rate only for a request queued in a round already rolled", () => {
    const vault = new PublicKey(new Uint8Array(32).fill(3));
    const request = { depositRound: 4n, depositAssets: 10n, redeemRound: 5n, redeemShares: 0n };
    expect(pendingRate(vault, null, 5n, "deposit")).toBeNull();
    expect(pendingRate(vault, request, 4n, "deposit")).toBeNull(); // still queued
    expect(pendingRate(vault, request, 5n, "deposit")?.toBase58()).toBe(rateAddress(vault, 4n).toBase58());
    expect(pendingRate(vault, request, 9n, "redeem")).toBeNull(); // nothing queued
  });

  it("parses feed ids with or without 0x and rejects anything else", () => {
    expect(feedIdBytes(TSLA_FEED_ID.slice(2))).toEqual(feedIdBytes(TSLA_FEED_ID));
    expect(feedIdBytes(TSLA_FEED_ID)[0]).toBe(0x16);
    expect(() => feedIdBytes("0x1234")).toThrow("32-byte feed id");
  });
});
