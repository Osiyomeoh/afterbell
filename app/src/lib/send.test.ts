import { describe, expect, it } from "vitest";

import { explain } from "./send";

describe("explain", () => {
  it("gives the program's own message when it refuses", () => {
    const logs = ["Program J6n3 invoke [1]", "Program log: AnchorError occurred. Error Code: QuoteExpired. Error Number: 6003. Error Message: The quote has expired.", "Program J6n3 failed"];
    expect(explain({ InstructionError: [1, { Custom: 6003 }] }, logs)).toBe("Devnet would refuse this: The quote has expired.");
  });

  it("says a wallet without devnet SOL needs some", () => {
    expect(explain("AccountNotFound", [])).toMatch(/needs a little devnet SOL/);
    expect(explain({ InstructionError: [1, { Custom: 1 }] }, ["Transfer: insufficient lamports 1000, need 2039280"])).toMatch(/needs a little devnet SOL/);
  });

  it("falls back to devnet's own error", () => {
    expect(explain({ InstructionError: [0, "InvalidAccountData"] }, [])).toBe('Devnet would refuse this transaction ({"InstructionError":[0,"InvalidAccountData"]}).');
  });
});
