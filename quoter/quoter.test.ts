import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import data from "../research/data/pyth-tsla-gaps.json" with { type: "json" };
import type { Opening } from "../pricing/model";
import { QUOTE_TYPES } from "../pricing/quote";
import { solanaQuoteMessage } from "../pricing/solanaQuote";
import { lastClose, nextOpen, scheduleEarlyCloses, scheduleHolidays, sessionSecsLeft } from "./calendar";
import { DEFAULT_QUOTER_CONFIG, priceQuote, referencePrice, signForEvm, signForSolana, type Market } from "./quoter";

const utc = (iso: string) => Date.parse(iso) / 1000;
// Friday 25 Sep 2026, 20:00 EDT, and the Monday open after it.
const FRIDAY_EVENING = utc("2026-09-26T00:00:00Z");
const MONDAY_OPEN = utc("2026-09-28T13:30:00Z");
// Monday 28 Sep 2026, 12:00 EDT: four hours of session left.
const MONDAY_NOON = utc("2026-09-28T16:00:00Z");

const TSLA: Market = {
  symbol: "TSLA",
  close: 380,
  live: 380,
  history: data.gaps as Opening[],
  annualVol: 0.6,
  holidays: new Set(),
};
const PROTECTION = { shares: 10, upper: 370, lower: 340 };

describe("calendar", () => {
  it("finds the next open across a weekend, in New York time", () => {
    expect(nextOpen(FRIDAY_EVENING, 180)).toBe(MONDAY_OPEN);
    expect(nextOpen(MONDAY_NOON, 180)).toBe(utc("2026-09-29T13:30:00Z"));
  });

  it("skips holidays and follows the switch back to EST", () => {
    const wednesdayEvening = utc("2026-11-25T22:00:00Z"); // 17:00 EST
    expect(nextOpen(wednesdayEvening, 180)).toBe(utc("2026-11-26T14:30:00Z"));
    expect(nextOpen(wednesdayEvening, 180, new Set(["2026-11-26"]))).toBe(utc("2026-11-27T14:30:00Z"));
  });

  it("moves to the following open once the lead time no longer fits", () => {
    expect(nextOpen(MONDAY_OPEN - 181, 180)).toBe(MONDAY_OPEN);
    expect(nextOpen(MONDAY_OPEN - 179, 180)).toBe(utc("2026-09-29T13:30:00Z"));
  });

  it("counts the regular session left, and none outside it", () => {
    expect(sessionSecsLeft(MONDAY_NOON)).toBe(4 * 3600);
    expect(sessionSecsLeft(FRIDAY_EVENING)).toBe(0);
    expect(sessionSecsLeft(MONDAY_OPEN - 1)).toBe(0);
    expect(sessionSecsLeft(MONDAY_NOON, new Set(["2026-09-28"]))).toBe(0);
  });

  it("finds the last close, including early closes", () => {
    expect(lastClose(FRIDAY_EVENING)).toBe(utc("2026-09-25T20:00:00Z"));
    expect(lastClose(MONDAY_NOON)).toBe(utc("2026-09-25T20:00:00Z"));
    expect(lastClose(utc("2026-09-28T20:00:00Z"))).toBe(utc("2026-09-28T20:00:00Z"));
    const early = new Map([["2026-11-27", { hour: 13, minute: 0 }]]);
    // Friday 27 Nov closes at 13:00 EST; by 15:00 the session is over.
    expect(lastClose(utc("2026-11-27T20:00:00Z"), new Set(["2026-11-26"]), early)).toBe(utc("2026-11-27T18:00:00Z"));
    expect(sessionSecsLeft(utc("2026-11-27T17:00:00Z"), new Set(), early)).toBe(3600);
    expect(sessionSecsLeft(utc("2026-11-27T19:00:00Z"), new Set(), early)).toBe(0);
  });

  it("reads holidays from Pyth's market-hours schedule", () => {
    const schedule = "America/New_York;0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C,C;1126/C,1127/0930-1300,0101/C";
    expect([...scheduleHolidays(schedule, FRIDAY_EVENING)].sort()).toEqual(["2026-11-26", "2027-01-01"]);
    expect([...scheduleEarlyCloses(schedule, FRIDAY_EVENING)]).toEqual([["2026-11-27", { hour: 13, minute: 0 }]]);
  });
});

describe("priceQuote", () => {
  it("prices protection until the next open at the model's odds plus the margin", () => {
    const p = priceQuote(FRIDAY_EVENING, TSLA, PROTECTION);
    expect(p.openTs).toBe(MONDAY_OPEN);
    expect(p.expiry).toBe(FRIDAY_EVENING + DEFAULT_QUOTER_CONFIG.ttlSecs);
    expect(p.premium).toBeCloseTo(p.expectedPayout * (1 + DEFAULT_QUOTER_CONFIG.margin), 9);
    expect(p.maxPayout).toBe(300);
    expect(p.premium).toBeGreaterThan(0);
    expect(p.premium).toBeLessThan(p.maxPayout);
    expect(p.probabilityOfPayout).toBeGreaterThan(0);
    expect(p.probabilityOfPayout).toBeLessThan(1);
    expect(p.model).toMatchObject({ source: "history", openings: 46 });
  });

  it("charges more during the session, which is still to run", () => {
    const evening = priceQuote(FRIDAY_EVENING, TSLA, PROTECTION);
    const noon = priceQuote(MONDAY_NOON, TSLA, PROTECTION);
    expect(noon.model.sd).toBeGreaterThan(evening.model.sd);
    expect(noon.premium).toBeGreaterThan(evening.premium);
  });

  it("never lets a quote outlive the cutoff before its open", () => {
    const cfg = DEFAULT_QUOTER_CONFIG;
    const late = MONDAY_OPEN - cfg.stopBeforeOpenSecs - cfg.ttlSecs;
    expect(priceQuote(late, TSLA, PROTECTION).openTs).toBe(MONDAY_OPEN);
    expect(priceQuote(late, TSLA, PROTECTION).expiry).toBe(MONDAY_OPEN - cfg.stopBeforeOpenSecs);
    expect(priceQuote(late + 1, TSLA, PROTECTION).openTs).toBe(utc("2026-09-29T13:30:00Z"));
  });

  it("refuses oversized, unpriced and pointless protection", () => {
    expect(() => priceQuote(FRIDAY_EVENING, TSLA, { ...PROTECTION, shares: 1_001 })).toThrow("at most 1000 shares");
    expect(() => priceQuote(FRIDAY_EVENING, { ...TSLA, close: 0, live: undefined }, PROTECTION)).toThrow("no closing price");
    expect(() => priceQuote(FRIDAY_EVENING, TSLA, { shares: 10, upper: 700, lower: 600 })).toThrow("costs as much as it can pay");
    expect(() => priceQuote(FRIDAY_EVENING, TSLA, { shares: 10, upper: 340, lower: 370 })).toThrow("upper must be above lower");
  });
});

describe("signing", () => {
  const priced = priceQuote(FRIDAY_EVENING, TSLA, PROTECTION);
  const key = (b: number) => bs58.encode(new Uint8Array(32).fill(b));

  it("signs a Solana quote the vault will accept", () => {
    const seed = new Uint8Array(32).fill(5);
    const vault = { programId: key(1), vault: key(2), feedId: "0x" + "07".repeat(32) };
    const s = signForSolana(priced, key(3), vault, seed);
    expect(s.quote).toMatchObject({ openTs: BigInt(MONDAY_OPEN), shares: 10_000_000n, upper: 37_000_000_000n, lower: 34_000_000_000n });
    expect(s.quote.premium).toBe(BigInt(Math.ceil(priced.premium * 1e6)));
    const message = solanaQuoteMessage(vault.programId, vault.vault, key(3), s.quote);
    expect(ed25519.verify(s.signature, message, bs58.decode(s.quoter))).toBe(true);
    expect(Buffer.from(s.ed25519Data.slice(112)).equals(Buffer.from(message))).toBe(true);
    // A fresh nonce per quote, so each buys once.
    expect(signForSolana(priced, key(3), vault, seed).quote.nonce).not.toEqual(s.quote.nonce);
  });

  it("signs an EVM quote that recovers to the quoter", async () => {
    const quoterKey = `0x${"11".repeat(32)}` as const;
    const ref = { chainId: 46630, vault: "0xFb94De7E63834a1271b9b7E316d7c13B66F38995", feed: "0x4A1166a659A55625345e9515b32adECea5547C38" } as const;
    const buyer = "0x000000000000000000000000000000000000bEEF";
    const s = await signForEvm(priced, buyer, ref, quoterKey);
    expect(s.quote.openTs).toBe(BigInt(MONDAY_OPEN));
    const signer = await recoverTypedDataAddress({
      domain: { name: "Afterbell", version: "1", chainId: ref.chainId, verifyingContract: ref.vault },
      types: QUOTE_TYPES,
      primaryType: "Quote",
      message: s.quote,
      signature: s.signature,
    });
    expect(signer).toBe(privateKeyToAccount(quoterKey).address);
  });
});

describe("reference price", () => {
  it("uses the live price in the session and refuses to quote without one", () => {
    expect(referencePrice(MONDAY_NOON, { ...TSLA, live: 390 })).toEqual({ price: 390, basis: "live" });
    expect(() => referencePrice(MONDAY_NOON, { ...TSLA, live: undefined })).toThrow("no live price during the session");
  });

  it("outside the session, prices a drop since the close but not a rise", () => {
    expect(referencePrice(FRIDAY_EVENING, { ...TSLA, live: 376 })).toEqual({ price: 376, basis: "live, below the close" });
    expect(referencePrice(FRIDAY_EVENING, { ...TSLA, live: 384 })).toEqual({ price: 380, basis: "close" });
    expect(referencePrice(FRIDAY_EVENING, { ...TSLA, live: undefined })).toEqual({ price: 380, basis: "close" });
  });

  it("makes protection dearer after a drop, never cheaper after a rise", () => {
    const flat = priceQuote(FRIDAY_EVENING, TSLA, PROTECTION).premium;
    expect(priceQuote(FRIDAY_EVENING, { ...TSLA, live: 376 }, PROTECTION).premium).toBeGreaterThan(flat);
    expect(priceQuote(FRIDAY_EVENING, { ...TSLA, live: 384 }, PROTECTION).premium).toBe(flat);
  });

  it("pauses sales after a move the history can't price", () => {
    expect(() => referencePrice(FRIDAY_EVENING, { ...TSLA, live: 360 })).toThrow("sales paused: the price has moved -5.3% since the close");
    expect(() => referencePrice(FRIDAY_EVENING, { ...TSLA, live: 400 })).toThrow("sales paused: the price has moved 5.3% since the close");
    expect(referencePrice(FRIDAY_EVENING, { ...TSLA, live: 362 }).basis).toBe("live, below the close");
  });
});
