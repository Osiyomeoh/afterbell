# Hedge backtest: the vault's nights, unhedged and hedged in xyz:TSLA

Generated 2026-09-27T12:49:33.786Z by `npm run hedger:backtest`.

Each night the vault sells protection on 10 TSLA at the close, priced from earlier openings only with the quoter's 15% margin, and pays it on Pyth's opening print (research/data/pyth-tsla-gaps.json), as pricing/backtest.ts does. The hedge is a short in Hyperliquid's xyz:TSLA at its own prices (the last trade before each moment, from research/data/hl-xyz-TSLA-15m.json, cached 2026-09-26T00:18:53.612Z), sized by the model's delta at that moment and traded when it leaves the hedger's dead band (0.01 TSLA or $10), then bought back at the open. Fees: 0.0090% of each trade, growth mode's taker rate at its highest. Funding is left out; the spread is too (mainnet's is $0.01).

The model gives the whole close-to-open move's width at every moment of the night: it doesn't narrow as the open nears. Rebalancing below follows the price, not the time left; that is how the hedger runs today.

## Protection 2% to 10% below the close

36 nights, 2026-08-05 → 2026-08-06 to 2026-09-24 → 2026-09-25; premiums $448.72, paid out $67.30 on 1 nights.

| Hedge | Total | Per night | SD | Worst | Best | Trades | Fees |
|---|---|---|---|---|---|---|---|
| Unhedged | $381.42 | $10.60 | $12.28 | −$57.25 | $23.62 |  |  |
| Short set at the close | $373.53 | $10.38 | $11.46 (−7%) | −$46.90 | $29.59 | 72 | $1.98 |
| Rebalanced every hour | $405.29 | $11.26 | $7.56 (−38%) | −$15.73 | $29.39 | 682 | $5.37 |
| Rebalanced every 15 minutes | $401.76 | $11.16 | $7.63 (−38%) | −$15.93 | $29.85 | 1751 | $7.81 |

Without the worst night unhedged (2026-09-03 → 2026-09-04), 35 nights:

| Hedge | Total | Per night | SD | Worst | Best | Trades | Fees |
|---|---|---|---|---|---|---|---|
| Unhedged | $438.68 | $12.53 | $4.00 | $8.79 | $23.62 |  |  |
| Short set at the close | $420.43 | $12.01 | $6.00 (+50%) | $1.47 | $29.59 | 70 | $1.93 |
| Rebalanced every hour | $421.02 | $12.03 | $6.06 (+52%) | $4.36 | $29.39 | 664 | $4.70 |
| Rebalanced every 15 minutes | $417.69 | $11.93 | $6.14 (+54%) | $4.30 | $29.85 | 1687 | $6.75 |

The three worst nights unhedged, and each hedge's result on them:

- 2026-09-03 → 2026-09-04: paid $67.30; unhedged −$57.25, short set at the close −$46.90, rebalanced every hour −$15.73, rebalanced every 15 minutes −$15.93
- 2026-09-24 → 2026-09-25: paid $0.00; unhedged $8.79, short set at the close $3.22, rebalanced every hour $4.98, rebalanced every 15 minutes $4.97
- 2026-09-16 → 2026-09-17: paid $0.00; unhedged $9.01, short set at the close $1.47, rebalanced every hour $4.43, rebalanced every 15 minutes $4.55

How 2026-09-03 → 2026-09-04 moved on Hyperliquid, from Pyth's close ($376.35), New York time: Thu 16:00 0.0%, Thu 20:00 −0.5%, Fri 00:00 −1.9%, Fri 04:00 −1.5%, Fri 08:00 −2.9%, Fri 09:30 −3.8%; Pyth's opening print −3.8%.

## Protection 1% to 5% below the close

36 nights, 2026-08-05 → 2026-08-06 to 2026-09-24 → 2026-09-25; premiums $449.68, paid out $260.80 on 8 nights.

| Hedge | Total | Per night | SD | Worst | Best | Trades | Fees |
|---|---|---|---|---|---|---|---|
| Unhedged | $188.88 | $5.25 | $19.89 | −$94.14 | $18.34 |  |  |
| Short set at the close | $168.95 | $4.69 | $15.09 (−24%) | −$69.72 | $20.54 | 72 | $3.65 |
| Rebalanced every hour | $218.92 | $6.08 | $7.56 (−62%) | −$27.54 | $18.19 | 883 | $10.61 |
| Rebalanced every 15 minutes | $213.93 | $5.94 | $7.36 (−63%) | −$26.23 | $17.80 | 2827 | $16.63 |

Without the worst night unhedged (2026-09-03 → 2026-09-04), 35 nights:

| Hedge | Total | Per night | SD | Worst | Best | Trades | Fees |
|---|---|---|---|---|---|---|---|
| Unhedged | $283.02 | $8.09 | $10.42 | −$23.97 | $18.34 |  |  |
| Short set at the close | $238.67 | $6.82 | $8.18 (−22%) | −$13.37 | $20.54 | 70 | $3.54 |
| Rebalanced every hour | $246.46 | $7.04 | $4.97 (−52%) | −$2.26 | $18.19 | 865 | $9.82 |
| Rebalanced every 15 minutes | $240.16 | $6.86 | $4.95 (−53%) | −$3.66 | $17.80 | 2761 | $15.44 |

The three worst nights unhedged, and each hedge's result on them:

- 2026-09-03 → 2026-09-04: paid $104.94; unhedged −$94.14, short set at the close −$69.72, rebalanced every hour −$27.54, rebalanced every 15 minutes −$26.23
- 2026-09-09 → 2026-09-10: paid $36.24; unhedged −$23.97, short set at the close −$11.35, rebalanced every hour −$2.26, rebalanced every 15 minutes −$1.11
- 2026-08-31 → 2026-09-01: paid $33.93; unhedged −$23.94, short set at the close −$13.37, rebalanced every hour −$2.20, rebalanced every 15 minutes −$3.66

How 2026-09-03 → 2026-09-04 moved on Hyperliquid, from Pyth's close ($376.35), New York time: Thu 16:00 0.0%, Thu 20:00 −0.5%, Fri 00:00 −1.9%, Fri 04:00 −1.5%, Fri 08:00 −2.9%, Fri 09:30 −3.8%; Pyth's opening print −3.8%.

One stock over a few dozen nights: read it as how the hedge behaves, not as proof of how much it saves.
