import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";

import { agentKey, emptyDexNote, loop } from "./common";

const NAME = "AFTERBELL_TEST_AGENT_KEY";
const ACCOUNT = "0x000000000000000000000000000000000000dEaD";

describe("agentKey", () => {
  afterEach(() => {
    delete process.env[NAME];
  });

  it("loads the API wallet's key from the environment", () => {
    const key = generatePrivateKey();
    process.env[NAME] = key;
    expect(agentKey(NAME, ACCOUNT).address).toBe(privateKeyToAccount(key).address);
  });

  it("refuses the account's own key, without printing it", () => {
    const key = generatePrivateKey();
    process.env[NAME] = key;
    const own = privateKeyToAccount(key).address;
    expect(() => agentKey(NAME, own)).toThrow(/account's own key/);
    expect(() => agentKey(NAME, own)).not.toThrow(key.slice(2));
  });

  it("refuses a missing or malformed key, without printing it", () => {
    expect(() => agentKey(NAME, ACCOUNT)).toThrow(/set AFTERBELL_TEST_AGENT_KEY/);
    process.env[NAME] = "0x1234not-a-key";
    expect(() => agentKey(NAME, ACCOUNT)).toThrow(/isn't a private key/);
    expect(() => agentKey(NAME, ACCOUNT)).not.toThrow(/not-a-key/);
  });
});

describe("loop", () => {
  it("runs at the times each run returns, goes on after a failed run, and stops on SIGINT after the run in flight", async () => {
    const ran: string[] = [];
    let n = 0;
    const errors: unknown[] = [];
    const log = console.error;
    console.error = (m: unknown) => errors.push(m);
    try {
      await loop(async () => {
        n++;
        if (n === 2) throw new Error("the read failed");
        ran.push(`run ${n}`);
        if (n === 4) process.emit("SIGINT");
        return Date.now() + 5;
      }, 5);
    } finally {
      console.error = log;
    }
    expect(ran).toEqual(["run 1", "run 3", "run 4"]);
    expect(String(errors[0])).toMatch(/failed: the read failed/);
  });
});

describe("emptyDexNote", () => {
  it("warns only when the account holds nothing on the dex", () => {
    expect(emptyDexNote(0, "xyz")).toMatch(/nothing on the xyz dex; move USDC there/);
    expect(emptyDexNote(0.01, "xyz")).toBeNull();
  });
});
