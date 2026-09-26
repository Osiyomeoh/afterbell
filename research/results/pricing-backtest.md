# Protection backtest: 10 TSLA at every close, priced from earlier openings only

Generated 2026-09-26T00:34:08.873Z by `npx tsx pricing/report.ts`. Openings: Pyth's first print at or after 09:30 ET (research/data/pyth-tsla-gaps.json).
Premiums are fair value (no margin). "Paid per $1" below 1 means buyers paid more than they got back over this sample; the vault's margin comes on top.

| Protection (below the close) | Nights | Premium | Paid | Paid per $1 | Nights it paid |
|---|---|---|---|---|---|
| 0.5% to 3.0% | 36 | $431.29 | $384.62 | 0.89 | 11 |
| 1.0% to 5.0% | 36 | $391.03 | $260.80 | 0.67 | 8 |
| 2.0% to 6.0% | 36 | $263.51 | $67.30 | 0.26 | 1 |
| 0.0% to 10.0% | 36 | $958.29 | $643.03 | 0.67 | 16 |

Nights that paid (1.0% to 5.0%):

- 2026-08-05 → 2026-08-06: close $321.41, open $317.09, premium $17.24, paid $11.03
- 2026-08-17 → 2026-08-18: close $339.33, open $333.32, premium $10.80, paid $26.17
- 2026-08-19 → 2026-08-20: close $351.17, open $346.27, premium $10.72, paid $13.91
- 2026-08-25 → 2026-08-26: close $350.23, open $345.28, premium $9.38, paid $14.48
- 2026-08-31 → 2026-09-01: close $368.04, open $360.97, premium $8.69, paid $33.93
- 2026-09-03 → 2026-09-04: close $376.35, open $362.09, premium $9.39, paid $104.94
- 2026-09-09 → 2026-09-10: close $367.87, open $360.57, premium $10.67, paid $36.24
- 2026-09-11 → 2026-09-14: close $365.48, open $359.81, premium $10.45, paid $20.10

This is 36 out-of-sample nights on one stock in a calm stretch; read it as a sanity check on the pricing, not as proof of an edge.
