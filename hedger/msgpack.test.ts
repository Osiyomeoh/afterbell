import { toHex } from "viem";
import { describe, expect, it } from "vitest";

import { pack, type Packable } from "./msgpack";

const hex = (v: Packable) => toHex(pack(v)).slice(2);

describe("pack", () => {
  it("writes each integer in its smallest form", () => {
    expect([0, 127, 128, 255, 256, 65535, 65536, 2 ** 32 - 1, 2 ** 32].map((n) => hex(n))).toEqual([
      "00",
      "7f",
      "cc80",
      "ccff",
      "cd0100",
      "cdffff",
      "ce00010000",
      "ceffffffff",
      "cf0000000100000000",
    ]);
    expect([-1, -32, -33, -128, -129, -32769, -(2 ** 31) - 1].map((n) => hex(n))).toEqual([
      "ff",
      "e0",
      "d0df",
      "d080",
      "d1ff7f",
      "d2ffff7fff",
      "d3ffffffff7fffffff",
    ]);
    expect(hex(2n ** 64n - 1n)).toBe("cfffffffffffffffff");
  });

  it("writes strings as UTF-8, with str8 from 32 bytes as Python's msgpack does", () => {
    expect(hex("")).toBe("a0");
    expect(hex("é")).toBe("a2c3a9");
    expect(hex("a".repeat(31))).toBe("bf" + "61".repeat(31));
    expect(hex("a".repeat(32))).toBe("d920" + "61".repeat(32));
    expect(hex("a".repeat(256)).slice(0, 6)).toBe("da0100");
  });

  it("writes arrays and maps, keeping the keys' order", () => {
    expect(hex([])).toBe("90");
    expect(hex(Array(15).fill(0))).toBe("9f" + "00".repeat(15));
    expect(hex(Array(16).fill(0))).toBe("dc0010" + "00".repeat(16));
    expect(hex({ b: 1, a: 2 })).toBe("82a16201a16102");
    const sixteen = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [String.fromCharCode(97 + i), i]));
    expect(hex(sixteen).slice(0, 6)).toBe("de0010");
    expect(hex([null, true, false])).toBe("93c0c3c2");
  });

  it("writes an action byte for byte", () => {
    // The SDK's dummy action, {"type": "dummy", "num": 100000000000}: num is a uint64.
    expect(hex({ type: "dummy", num: 100_000_000_000 })).toBe("82a474797065a564756d6d79a36e756dcf000000174876e800");
  });

  it("refuses what an action never holds", () => {
    expect(() => pack(1.5)).toThrow();
    expect(() => pack(Number.NaN)).toThrow();
    expect(() => pack(2 ** 60)).toThrow();
    expect(() => pack({ c: undefined } as unknown as Packable)).toThrow();
  });
});
