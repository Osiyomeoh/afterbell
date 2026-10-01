"use client";

import { useEffect, useState } from "react";

import { fetchMarket, type MarketResponse } from "@/lib/api";

import { RobinhoodPositions } from "./positions/robinhood";
import { Panel } from "./positions/shared";
import { SolanaPositions } from "./positions/solana";

/** A wallet's protection on each chain, with a claim button once its series has settled or voided. */
export function Positions() {
  const [market, setMarket] = useState<MarketResponse | null>(null);
  useEffect(() => {
    fetchMarket().then(setMarket, () => {});
  }, []);

  return (
    <div className="space-y-10">
      <section>
        <h2 className="mb-3 text-sm font-medium text-muted">Solana devnet</h2>
        {market?.solana ? (
          <SolanaPositions vault={{ vault: market.solana.vault, collateralMint: market.solana.collateralMint }} nextOpen={market.nextOpen} />
        ) : (
          <Panel>{market ? "The Solana vault v2 isn't deployed yet." : "Loading…"}</Panel>
        )}
      </section>
      <section>
        <h2 className="mb-3 text-sm font-medium text-muted">Robinhood Chain</h2>
        {market?.robinhood ? (
          <RobinhoodPositions d={market.robinhood} />
        ) : (
          <Panel>{market ? "The Robinhood Chain vault isn't deployed yet." : "Loading…"}</Panel>
        )}
      </section>
    </div>
  );
}
