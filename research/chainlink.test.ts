import { describe, expect, it } from "vitest";

import { decodeRound, encodeRoundId } from "./chainlink";

const word = (n: bigint) => (BigInt.asUintN(256, n)).toString(16).padStart(64, "0");

describe("Chainlink round codec", () => {
  it("encodes getRoundData(uint80) with the phase in the high bits", () => {
    const id = (1n << 64n) | 0x557n;
    expect(encodeRoundId(id)).toBe("0x9a6fc8f5" + "0".repeat(47) + "10000000000000557");
    expect(encodeRoundId(id)).toHaveLength(10 + 64);
  });

  it("decodes roundId, an 8-decimal answer and updatedAt", () => {
    // The live TSLA round read on 2026-09-26: answer 0x8a7c90ef0 = $371.7471
    const hex = "0x" + word((1n << 64n) | 0x557n) + word(0x8a7c90ef0n) + word(0x6ab6c534n) + word(0x6ab6c540n) + word((1n << 64n) | 0x557n);
    const r = decodeRound(hex)!;
    expect(r.roundId).toBe(((1n << 64n) | 0x557n).toString());
    expect(r.answer).toBeCloseTo(371.7471, 8);
    expect(r.updatedAt).toBe(0x6ab6c540);
  });

  it("decodes a negative answer as negative", () => {
    const hex = "0x" + word(1n) + word(-5n * 10n ** 8n) + word(1n) + word(2n) + word(1n);
    expect(decodeRound(hex)!.answer).toBe(-5);
  });

  it("treats a round with updatedAt 0 as missing", () => {
    const hex = "0x" + word(1n) + word(1n) + word(0n) + word(0n) + word(1n);
    expect(decodeRound(hex)).toBeNull();
  });

  it("rejects short return data", () => {
    expect(decodeRound("0x")).toBeNull();
  });
});
