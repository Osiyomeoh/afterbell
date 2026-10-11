import { Keypair, type TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { joinWaitlistTx, MEMO_PROGRAM_ID, parseWaitlistMemo, tally, WAITLIST, waitlistMemo, type Signup } from "./waitlist";

describe("the waitlist's memo", () => {
  it("round-trips a role and the stocks", () => {
    const memo = waitlistMemo("borrower", ["TSLA", "QQQ"]);
    expect(memo).toBe("afterbell waitlist v1 role=borrower stocks=TSLA,QQQ");
    expect(parseWaitlistMemo(memo)).toEqual({ role: "borrower", stocks: ["TSLA", "QQQ"] });
  });

  it("keeps only stocks we list, once each, uppercased, at most five", () => {
    expect(waitlistMemo("holder", ["tsla", "TSLA", "NOPE", "QQQ"])).toBe("afterbell waitlist v1 role=holder stocks=TSLA,QQQ");
    expect(parseWaitlistMemo("afterbell waitlist v1 role=holder stocks=")).toEqual({ role: "holder", stocks: [] });
  });

  it("ignores anything else sent to the address", () => {
    expect(parseWaitlistMemo("gm")).toBeNull();
    expect(parseWaitlistMemo("afterbell waitlist v1 role=whale stocks=TSLA")).toBeNull();
    expect(parseWaitlistMemo("afterbell waitlist v2 role=holder stocks=TSLA")).toBeNull();
  });
});

describe("joining", () => {
  it("sends nothing to the waitlist's address, with the memo signed by the wallet", () => {
    const owner = Keypair.generate().publicKey;
    const ixs = joinWaitlistTx(owner, "agent", ["TSLA"]).instructions;
    expect(ixs).toHaveLength(2);
    const [transfer, memo] = ixs as [TransactionInstruction, TransactionInstruction];
    expect(transfer.keys.map((k) => k.pubkey.toBase58())).toEqual([owner.toBase58(), WAITLIST.toBase58()]);
    expect(transfer.data.readBigUInt64LE(4)).toBe(0n);
    expect(memo.programId.equals(MEMO_PROGRAM_ID)).toBe(true);
    expect(memo.keys).toEqual([{ pubkey: owner, isSigner: true, isWritable: false }]);
    expect(memo.data.toString("utf8")).toBe("afterbell waitlist v1 role=agent stocks=TSLA");
  });

  it("uses an address no one can sign for", () => {
    expect(WAITLIST.toBase58()).toBe("BhZsWmXimERPNHJqCSPWRML4BHcVqrr95tBf48WHejff");
    expect(Keypair.generate().publicKey.equals(WAITLIST)).toBe(false);
  });
});

describe("counting the list", () => {
  const s = (wallet: string, role: Signup["role"], time: number): Signup => ({ wallet, role, stocks: ["TSLA"], signature: `${wallet}-${time}`, time });

  it("counts each wallet once, at its latest answer, newest first", () => {
    const v = tally([s("a", "holder", 1), s("b", "borrower", 2), s("a", "protocol", 3)], new Set(), new Set());
    expect(v.count).toBe(2);
    expect(v.signups.map((x) => [x.wallet, x.role])).toEqual([
      ["a", "protocol"],
      ["b", "borrower"],
    ]);
    expect(v.byRole).toEqual({ holder: 0, borrower: 1, protocol: 1, agent: 0 });
  });

  it("ranks the stocks the list asks for", () => {
    const v = tally(
      [{ ...s("a", "holder", 1), stocks: ["QQQ", "TSLA"] }, { ...s("b", "holder", 2), stocks: ["TSLA"] }, { ...s("c", "agent", 3), stocks: ["AAPL"] }],
      new Set(),
      new Set(),
    );
    expect(v.wanted).toEqual([
      { symbol: "TSLA", count: 2 },
      { symbol: "AAPL", count: 1 },
      { symbol: "QQQ", count: 1 },
    ]);
  });

  it("leaves the team out, and says how many on the list also bought test cover", () => {
    const v = tally([s("ours", "holder", 1), s("a", "holder", 2), s("b", "holder", 3)], new Set(["ours"]), new Set(["a", "c"]));
    expect(v.count).toBe(2);
    expect(v.tried).toBe(1);
    expect(v.testers).toBe(2);
  });
});
