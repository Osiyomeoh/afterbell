import { describe, expect, it } from "vitest";

import { date, metadata, money, price, shares, svg, type Card } from "./art";

const card: Card = {
  number: 7n,
  symbol: "TSLA",
  openTs: 1_790_343_000n,
  shares: 2_500_000n,
  upper: 360n * 100_000_000n,
  lower: 340n * 100_000_000n,
  premium: 20_000_000n,
  maxPayout: 50_000_000n,
  state: "settled",
  price: 35_550_000_000n,
  payout: 11_250_000n,
  closed: true,
  forfeited: false,
};

describe("Solana position art", () => {
  // evm/src/PositionArt.sol's svg() for the same card, printed by forge: the NFTs look the same on either chain.
  it("draws exactly what the EVM contract draws", () => {
    expect(svg(card)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" font-family="ui-monospace,Menlo,monospace"><rect width="400" height="400" rx="22" fill="#101214"/><text x="28" y="46" font-size="12" fill="#c9a45c">AFTERBELL  PROTECTION #7</text><text x="28" y="98" font-size="44" font-family="Georgia,serif" fill="#ecebe7">TSLA</text><text x="28" y="126" font-size="13" fill="#8b9098">until the 09:30 ET open, 25 Sep 2026</text><line x1="28" y1="292" x2="372" y2="292" stroke="#2a2e33"/><polyline fill="none" stroke="#c9a45c" stroke-width="3" stroke-linejoin="round" points="28,176 131,176 268,292 372,292"/><text x="28" y="166" font-size="12" fill="#8b9098">pays up to $50.00</text><text x="131" y="312" font-size="11" fill="#8b9098">$340.00</text><text x="268" y="312" font-size="11" fill="#8b9098">$360.00</text><line x1="237" y1="150" x2="237" y2="292" stroke="#ecebe7" stroke-dasharray="4 4"/><text x="28" y="338" font-size="14" fill="#ecebe7">2.5 shares  |  cost $20.00</text><text x="28" y="364" font-size="14" fill="#6fcf97">Opened at $355.50  |  paid $11.25</text></svg>',
    );
  });

  // The cases in evm/test/Positions.t.sol.
  it("follows the position from open to paid, or refunded", () => {
    const open: Card = { ...card, state: "open", closed: false, shares: 10_000_000n, maxPayout: 200_000_000n };
    expect(svg(open)).toContain("10 shares  |  cost $20.00");
    expect(svg(open)).toContain("Open until the bell");
    expect(svg(open)).not.toContain("stroke-dasharray");
    expect(svg({ ...open, state: "settled", payout: 45_000_000n })).toContain("Opened at $355.50  |  pays $45.00");
    expect(svg({ ...open, state: "voided" })).toContain("Voided: premium to refund");
    expect(svg({ ...open, state: "voided", closed: true })).toContain("Voided: premium refunded");
    expect(svg({ ...card, payout: 0n, forfeited: true })).toContain("Forfeited: its NFT was burned");
  });

  it("names the NFT as it's named on-chain and links its image", () => {
    const m = metadata(card, "https://example.com/art.svg");
    expect(m.name).toBe("Afterbell #7 TSLA");
    expect(m.symbol).toBe("BELL");
    expect(m.image).toBe("https://example.com/art.svg");
    expect(m.attributes).toContainEqual({ trait_type: "Status", value: "Paid" });
    expect(metadata({ ...card, forfeited: true }, "").attributes).toContainEqual({ trait_type: "Status", value: "Forfeited" });
  });

  it("formats as the contract does", () => {
    expect(price(38_382_840_000n)).toBe("383.83");
    expect(money(4_995n)).toBe("0.00");
    expect(money(5_000n)).toBe("0.01");
    expect(shares(10_000_000n)).toBe("10");
    expect(shares(1_000_001n)).toBe("1.000001");
    expect(date(1_790_343_000n)).toBe("25 Sep 2026");
    expect(svg({ ...card, symbol: "<b>" })).toContain(">&lt;b&gt;<");
  });
});
