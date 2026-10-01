import type { Address, PublicClient } from "viem";
import { describe, expect, it } from "vitest";

import type { EvmPosition } from "../evm/client/vault";
import { evmVault, openEvmPositions, readEvmVault, type EvmPositionRecord } from "./evm";

const TSLA_FEED: Address = "0x4A1166a659A55625345e9515b32adECea5547C38";
const OTHER_FEED: Address = "0x80901d846d5D7B030F26B480776EE3b29374C2ae";
const VAULT: Address = "0x000000000000000000000000000000000000bEEF";
const OPEN = 1_790_003_600n;

const position = (feed: Address, shares: number, upper: number, lower: number, closed = false): EvmPositionRecord => ({
  feed,
  openTs: OPEN,
  shares: BigInt(shares * 1e6),
  upper: BigInt(upper * 1e8),
  lower: BigInt(lower * 1e8),
  closed,
});

/** A chain holding `positions`, answering the vault's reads as viem would. */
function fakeClient(positions: EvmPositionRecord[], asked: string[] = []): PublicClient {
  const full = positions.map((p): EvmPosition => ({ ...p, buyer: VAULT, premium: 1n, maxPayout: 1n, tip: 0n, paid: 0n }));
  return {
    readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
      if (address !== VAULT) throw new Error(`read of ${address}, not the vault`);
      asked.push(args ? `${functionName}(${args.join(",")})` : functionName);
      if (functionName === "nextPositionId") return BigInt(full.length);
      if (functionName === "position") return full[Number(args![0])];
      throw new Error(`unexpected ${functionName}`);
    },
  } as unknown as PublicClient;
}

describe("openEvmPositions", () => {
  it("takes shares and strikes out of the contract's units, and leaves out positions already paid", () => {
    const open = openEvmPositions([position(TSLA_FEED, 2, 390, 370), position(TSLA_FEED, 1, 380, 360, true)], { TSLA: TSLA_FEED });
    expect(open).toEqual([{ symbol: "TSLA", openTs: Number(OPEN), shares: 2, upper: 390, lower: 370 }]);
  });

  it("names each position by the deployment's feed list, whatever the address's case", () => {
    const open = openEvmPositions([position(TSLA_FEED.toLowerCase() as Address, 1, 380, 360)], { TSLA: TSLA_FEED });
    expect(open[0]?.symbol).toBe("TSLA");
  });

  it("keeps a feed the deployment doesn't list under its address, so it's never hedged as another stock", () => {
    const open = openEvmPositions([position(OTHER_FEED, 3, 600, 550)], { TSLA: TSLA_FEED });
    expect(open).toEqual([{ symbol: OTHER_FEED, openTs: Number(OPEN), shares: 3, upper: 600, lower: 550 }]);
  });
});

describe("readEvmVault", () => {
  it("reads every position the vault has sold, in order", async () => {
    const sold = [position(TSLA_FEED, 2, 390, 370), position(TSLA_FEED, 1, 380, 360, true), position(OTHER_FEED, 3, 600, 550)];
    const asked: string[] = [];
    const read = await readEvmVault(fakeClient(sold, asked), VAULT);
    expect(read.map((p) => [p.feed, p.shares, p.closed])).toEqual(sold.map((p) => [p.feed, p.shares, p.closed]));
    expect(asked).toEqual(["nextPositionId", "position(0)", "position(1)", "position(2)"]);
  });

  it("reads nothing more from a vault that hasn't sold", async () => {
    const asked: string[] = [];
    expect(await readEvmVault(fakeClient([], asked), VAULT)).toEqual([]);
    expect(asked).toEqual(["nextPositionId"]);
  });
});

describe("evmVault", () => {
  it("is a Robinhood Chain source whose read gives the open positions", async () => {
    const source = evmVault("Robinhood Chain", fakeClient([position(TSLA_FEED, 2, 390, 370), position(TSLA_FEED, 1, 380, 360, true)]), { vault: VAULT, feeds: { TSLA: TSLA_FEED } });
    expect(source).toMatchObject({ chain: "robinhood", label: "Robinhood Chain", vault: VAULT });
    expect(await source.read()).toEqual([{ symbol: "TSLA", openTs: Number(OPEN), shares: 2, upper: 390, lower: 370 }]);
  });
});
